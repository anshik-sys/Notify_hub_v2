// Behaviour tests from docs/expected-behaviour.md section 13: "Connect Google
// Calendar" (GC1–GC18). Written from the spec, not the code: a failure means
// one of them is wrong. Approved as written, with its proposed rules and the
// proposed answers to its open questions (any Google account; disconnecting
// or an admin blocking it deletes the "NotifyHub" calendar; waiting-for-
// approval and No-answered events are left out; 30 days back, a year ahead;
// the invite + NotifyHub duplicate is accepted).
//
// Google is an in-memory fake (FakeGoogle below) passed as `fetch`: the token
// and revoke endpoints and the Calendar API. Every test connects its own fresh
// person through connectGoogle with its own fake, and asserts on its own
// explicit syncGoogle calls. Entries are dated 2031 and syncGoogle gets a fixed
// `now` (NOW), so a live worker has nothing to send for them.
//
// A live worker may run against the same database and would sync these
// connections with the real Google every minute ("tick"). before() waits for a
// quiet window just after a tick so the whole file runs between two ticks.
//
// Left for a manual check in the browser: the OAuth redirect, Google's real
// consent screen, the "Connected as …" / "Reconnect" text on Profile and the
// Connect button hiding.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "@/lib/auth";
import { decrypt } from "@/lib/crypto";
import { addMember } from "@/lib/departments";
import { respond } from "@/lib/events";
import { connectGoogle, disconnectGoogle, getGoogleConnection, googleAllowed, setGoogleCalendarEnabled } from "@/lib/google-calendar";
import { consentUrl, GOOGLE_CALENDAR_SCOPES, googleEvent, googleEventId } from "@/lib/google";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "@/lib/permissions";
import { exportPerson } from "@/lib/privacy";
import { cancelReminder, createReminder, deleteReminder, moveEntry, type RawReminder, type ReminderInput, updateReminder, validateInput } from "@/lib/reminders";
import { seeder } from "@/lib/test-helpers";
import { erasePerson, setActive } from "@/lib/users";
import { ownerDb } from "./db";
import { dispatchInvites } from "./delivery";
import { googleSyncTargets, syncGoogle } from "./google-sync";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

const NOW = new Date("2031-06-01T12:00:00Z");
const DAY = 86_400_000;
const MIN = 60_000;
const at = (iso: string) => new Date(iso);
const APP = new URL(process.env.BETTER_AUTH_URL!).origin;

let admin: string, olga: string;
const emailOf = (id: string) => `${id}@${s.domain}`;
const actor = async (id: string) => ({ id, name: id, email: emailOf(id), access: await loadAccess(s.companyId, id) });

// --- Fake Google ----------------------------------------------------------------

type GEvent = Record<string, unknown> & {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  attendees?: unknown[];
};
type Cal = { id: string; summary: string; events: Map<string, GEvent> };
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

class FakeGoogle {
  calendars = new Map<string, Cal>();
  deletedCalendars: string[] = [];
  calls: { method: string; url: string; body: string }[] = [];
  codes = new Map<string, string>(); // code -> google email
  refresh = new Map<string, string>(); // refresh token -> email
  access = new Set<string>();
  revoked = new Set<string>();
  issued: string[] = []; // every token handed out (to look for leaks)
  mode: "up" | "down" | "revoked" = "up";
  grantCalendarScope = true;

  code(email: string) {
    const c = `code-${randomUUID()}`;
    this.codes.set(c, email);
    return c;
  }
  get calendar(): Cal | undefined {
    return [...this.calendars.values()][0];
  }
  get writes() {
    return this.calls.filter((c) => c.url.startsWith(API) && c.method !== "GET");
  }
  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  private tokens(email: string, withRefresh: boolean) {
    const a = `ya29.fake-${randomUUID()}`;
    this.access.add(a);
    this.issued.push(a);
    const out: Record<string, unknown> = {
      access_token: a,
      expires_in: 3599,
      token_type: "Bearer",
      scope: (this.grantCalendarScope ? GOOGLE_CALENDAR_SCOPES : GOOGLE_CALENDAR_SCOPES.filter((x) => !x.includes("calendar"))).join(" "),
      id_token: `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: "https://accounts.google.com", sub: email, email, email_verified: true })}.sig`,
    };
    if (withRefresh) {
      const r = `1//fake-refresh-${randomUUID()}`;
      this.refresh.set(r, email);
      this.issued.push(r);
      out.refresh_token = r;
    }
    return out;
  }

  fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : init.body ? String(init.body) : "";
    this.calls.push({ method, url, body });
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));

    if (url.startsWith(TOKEN)) {
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "authorization_code") {
        const email = this.codes.get(p.get("code") ?? "");
        if (!email) return this.json({ error: "invalid_grant", error_description: "Bad Request" }, 400);
        this.codes.delete(p.get("code")!);
        return this.json(this.tokens(email, true));
      }
      if (p.get("grant_type") === "refresh_token") {
        const r = p.get("refresh_token") ?? "";
        const email = this.refresh.get(r);
        if (!email || this.revoked.has(r) || this.mode === "revoked") return this.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
        if (this.mode === "down") return this.json({ error: "backend_error" }, 503);
        return this.json(this.tokens(email, false));
      }
      return this.json({ error: "unsupported_grant_type" }, 400);
    }
    if (url.startsWith(REVOKE)) {
      const t = new URLSearchParams(body).get("token") ?? new URL(url).searchParams.get("token") ?? "";
      this.revoked.add(t);
      this.access.delete(t);
      return this.json({});
    }
    if (!url.startsWith(API)) return this.json({ error: `fake google: unexpected ${method} ${url}` }, 599);

    if (this.mode === "down") return this.json({ error: { code: 503, message: "Backend Error" } }, 503);
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (this.mode === "revoked" || !this.access.has(bearer)) return this.json({ error: { code: 401, message: "Invalid Credentials" } }, 401);

    const path = new URL(url).pathname.replace(/^\/calendar\/v3/, "").split("/").filter(Boolean).map(decodeURIComponent);
    // /calendars
    if (path.length === 1 && path[0] === "calendars" && method === "POST") {
      const b = JSON.parse(body || "{}");
      const id = `${randomUUID().replace(/-/g, "")}@group.calendar.google.com`;
      this.calendars.set(id, { id, summary: b.summary, events: new Map() });
      return this.json({ kind: "calendar#calendar", id, summary: b.summary, timeZone: b.timeZone });
    }
    if (path[0] !== "calendars" || path.length < 2) return this.json({ error: { code: 404, message: "Not Found" } }, 404);
    const cal = this.calendars.get(path[1]);
    if (!cal) return this.json({ error: { code: 404, message: "Not Found" } }, 404);
    if (path.length === 2) {
      if (method === "DELETE") {
        this.calendars.delete(cal.id);
        this.deletedCalendars.push(cal.id);
        return new Response(null, { status: 204 });
      }
      if (method === "GET") return this.json({ id: cal.id, summary: cal.summary });
    }
    if (path[2] !== "events") return this.json({ error: { code: 404, message: "Not Found" } }, 404);
    if (path.length === 3) {
      if (method === "POST") {
        const b = JSON.parse(body || "{}") as GEvent;
        if (!b.id) b.id = randomUUID().replace(/-/g, "");
        if (cal.events.has(b.id)) return this.json({ error: { code: 409, message: "The requested identifier already exists." } }, 409);
        cal.events.set(b.id, b);
        return this.json(b);
      }
      if (method === "GET") return this.json({ items: [...cal.events.values()] });
    }
    if (path.length === 4) {
      const eid = path[3];
      const ev = cal.events.get(eid);
      if (!ev) return this.json({ error: { code: 404, message: "Not Found" } }, 404);
      if (method === "DELETE") {
        cal.events.delete(eid);
        return new Response(null, { status: 204 });
      }
      if (method === "PUT") {
        const b = JSON.parse(body || "{}") as GEvent;
        cal.events.set(eid, { ...b, id: eid });
        return this.json({ ...b, id: eid });
      }
      if (method === "PATCH") {
        const b = JSON.parse(body || "{}") as GEvent;
        cal.events.set(eid, { ...ev, ...b, id: eid });
        return this.json(cal.events.get(eid));
      }
      if (method === "GET") return this.json(ev);
    }
    return this.json({ error: { code: 404, message: "Not Found" } }, 404);
  }) as typeof fetch;
}

// --- Seeding ----------------------------------------------------------------------

// A fresh member, connected with a fresh fake Google (gmail by default).
async function connected(o: { google?: string; roles?: string[] } = {}) {
  const id = await s.user({ roles: o.roles ?? [MEMBER_ROLE_ID] });
  const g = new FakeGoogle();
  const email = o.google ?? `p${id.slice(0, 8)}@gmail.com`;
  assert.equal(await connectGoogle(s.companyId, id, g.code(email), g.fetch), null, "connectGoogle succeeds");
  return { id, g, email };
}
const sync = async (userId: string, g: FakeGoogle, now = NOW) => syncGoogle(userId, g.fetch, now);
const eventIn = (g: FakeGoogle, reminderId: string) => g.calendar?.events.get(googleEventId(reminderId));
const conn = async (userId: string) => (await q("select * from google_calendars where user_id = $1", [userId]))[0];
const targets = async () => new Set(await googleSyncTargets());

let n = 0;
type Seed = {
  title?: string;
  description?: string;
  status?: string;
  sendAt?: Date;
  by?: string;
  isTask?: boolean;
  isEvent?: boolean;
  duration?: number | null;
  allDay?: boolean;
  location?: string | null;
  meetingUrl?: string | null;
  recurrence?: object | null;
  anchor?: string;
  deleted?: boolean;
  replaces?: [string, Date];
  targets?: [string, string | null][];
};
async function seed(o: Seed = {}) {
  const sendAt = o.sendAt ?? at("2031-07-01T09:00:00Z");
  const isEvent = o.isEvent ?? false;
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status, time_zone, anchor_local,
       is_task, due_after_minutes, is_event, duration_minutes, all_day, location, meeting_url, channels, recurrence, deleted_at,
       replaces_series_id, replaces_occurs_at)
     values ($1, $2, $3, $4, $5, 'Olga', $6, $7, 'UTC', $8, $9, $10, $11, $12, $13, $14, $15, '{email}', $16, ${o.deleted ? "now()" : "null"}, $17, $18)
     returning id`,
    [
      s.companyId,
      `GC-${s.companyId.slice(0, 6)}-${n++}`,
      o.by ?? olga,
      o.title ?? `Entry ${n}`,
      o.description ?? "",
      sendAt,
      o.status ?? "scheduled",
      o.anchor ?? sendAt.toISOString().slice(0, 16),
      o.isTask ?? false,
      o.isTask ? 60 : null,
      isEvent,
      isEvent ? (o.duration ?? 60) : null,
      o.allDay ?? false,
      o.location ?? null,
      o.meetingUrl ?? null,
      o.recurrence ? JSON.stringify(o.recurrence) : null,
      o.replaces?.[0] ?? null,
      o.replaces?.[1] ?? null,
    ],
  );
  for (const [kind, ref] of o.targets ?? []) await q("insert into reminder_targets (reminder_id, company_id, kind, ref) values ($1, $2, $3, $4)", [id, s.companyId, kind, ref]);
  return id as string;
}
// What the worker leaves behind once a reminder has gone out to someone.
async function delivered(reminderId: string, userId: string, when: Date) {
  const [{ id: occ }] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, $3, 'sent') returning id", [s.companyId, reminderId, when]);
  await q(
    "insert into deliveries (company_id, reminder_id, address, user_id, status, sent_at, occurrence_id, channel, kind) values ($1, $2, $3, $4, 'sent', $5, $6, 'email', 'reminder')",
    [s.companyId, reminderId, emailOf(userId), userId, when, occ],
  );
}
async function department(...members: string[]) {
  const [{ id }] = await q("insert into departments (company_id, name) values ($1, $2) returning id", [s.companyId, `D-${randomUUID().slice(0, 8)}`]);
  for (const m of members) await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, id, m]);
  return id as string;
}
async function group(...members: string[]) {
  const [{ id }] = await q("insert into groups (company_id, name, created_by) values ($1, $2, $3) returning id", [s.companyId, `G-${randomUUID().slice(0, 8)}`, admin]);
  for (const m of members) await q("insert into group_members (group_id, company_id, user_id) values ($1, $2, $3)", [id, s.companyId, m]);
  return id as string;
}

// Reminder / event input as the New / Edit form would send it (admin creates).
const NO_REPEAT = { repeat: "none", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" };
function input(o: { title?: string; start?: string; users?: string[]; isEvent?: boolean }): ReminderInput {
  const start = o.start ?? "2031-07-01T09:00";
  const raw: RawReminder = {
    title: o.title ?? "Planning",
    description: "Bring numbers",
    senderName: "Admin",
    linkLabels: [],
    linkUrls: [],
    company: false,
    departmentIds: [],
    groupIds: [],
    userIds: o.users ?? [],
    emails: "",
    when: "later",
    sendAtLocal: start,
    repeat: NO_REPEAT,
    isTask: false,
    dueLocal: "",
    channels: ["email"],
    slackChannelIds: [],
    tags: "",
    shareMine: false,
    shareDepartmentIds: [],
    shareGroupIds: [],
    shareCompany: false,
    isEvent: o.isEvent ?? false,
    endLocal: o.isEvent ? start.replace(/T09:00$/, "T10:00") : "",
    allDay: false,
    location: o.isEvent ? "Room 2" : "",
    meetingUrl: o.isEvent ? "https://meet.example.com/abc-defg" : "",
    notifyBefore: [],
  };
  const r = validateInput(raw, "UTC", "Admin");
  assert.ok("input" in r && r.input, `valid input: ${JSON.stringify(r)}`);
  return r.input;
}
async function create(o: Parameters<typeof input>[0]) {
  const r = await createReminder(await actor(admin), s.companyId, input(o));
  assert.ok("id" in r, JSON.stringify(r));
  const [{ status }] = await q("select status from reminders where id = $1", [r.id]);
  assert.equal(status, "scheduled", "admin's reminder is scheduled straight away");
  return r.id as string;
}

// Wait for a quiet window after a live worker's tick (see the header).
async function quietWindow() {
  const sec = new Date().getUTCSeconds();
  if (sec >= 8 && sec < 15) return;
  const wait = ((68 - sec) % 60) * 1000 - new Date().getUTCMilliseconds();
  await new Promise((r) => setTimeout(r, wait));
}

before(async () => {
  await s.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  olga = await s.user({ roles: [MEMBER_ROLE_ID] });
  await quietWindow();
});
after(async () => {
  await q("delete from google_calendars where company_id = $1", [s.companyId]);
  await q("delete from audit_log where company_id = $1", [s.companyId]);
  await s.cleanup();
  await ownerDb.$client.end();
  await db.$client.end();
  await authDb.$client.end();
});

// --- Connecting -----------------------------------------------------------------

test("GC1: consent asks only for openid, email and calendar.app.created, offline; on Allow it is connected as the Google address and a NotifyHub calendar appears", async () => {
  const u = new URL(consentUrl("state-123"));
  const scopes = (u.searchParams.get("scope") ?? "").split(/[ +]/).filter(Boolean).sort();
  assert.deepEqual(scopes, ["email", "https://www.googleapis.com/auth/calendar.app.created", "openid"], "the only scopes asked for");
  assert.equal(u.searchParams.get("access_type"), "offline", "offline access (keeps working when signed out)");
  assert.equal(u.searchParams.get("state"), "state-123", "the state is passed through");
  assert.equal(u.searchParams.get("response_type"), "code");

  const { id, g, email } = await connected({ google: "name@gmail.com" });
  const c = await getGoogleConnection(s.companyId, id);
  assert.ok(c, "a connection is shown on Profile");
  assert.equal((c as { googleEmail?: string }).googleEmail, email, "Connected as name@gmail.com");
  assert.equal(await sync(id, g), "synced");
  assert.equal(g.calendars.size, 1, "one calendar was made in Google");
  assert.equal(g.calendar!.summary, "NotifyHub", 'the calendar is called "NotifyHub"');
  // SKIP part: the redirect back to Profile and the "Connected as" text (browser).
});

test("GC2: any Google account can be connected, not only one matching the NotifyHub email", async () => {
  const { id, g } = await connected({ google: "someone.else@gmail.com" });
  const [u] = await q(`select email from "user" where id = $1`, [id]);
  assert.notEqual(u.email, "someone.else@gmail.com");
  const c = (await getGoogleConnection(s.companyId, id)) as { googleEmail?: string } | null;
  assert.equal(c?.googleEmail, "someone.else@gmail.com");
  const r = await seed({ title: "GC2 mine", by: id });
  assert.equal(await sync(id, g), "synced");
  assert.ok(eventIn(g, r), "its reminders sync to that account");
});

test("GC3: a failed exchange (or the calendar permission left unticked) returns a message and stores nothing", async () => {
  const id = await s.user({ roles: [MEMBER_ROLE_ID] });
  const g = new FakeGoogle();
  const err = await connectGoogle(s.companyId, id, "code-that-google-rejects", g.fetch);
  assert.equal(typeof err, "string", "an error message for Profile");
  assert.ok(err!.length > 0);
  assert.equal(await conn(id), undefined, "nothing stored after a failed exchange");
  assert.equal(await getGoogleConnection(s.companyId, id), null, "Profile shows not connected");

  g.grantCalendarScope = false;
  const err2 = await connectGoogle(s.companyId, id, g.code("x@gmail.com"), g.fetch);
  assert.equal(typeof err2, "string", "an error when the calendar permission wasn't granted");
  assert.equal(await conn(id), undefined, "nothing stored without the calendar permission");
  // SKIP part: Deny on Google's screen (the route gets ?error=access_denied) and the message on Profile.
});

test("GC4: tokens are stored encrypted, never shown (Profile, export) or logged", async () => {
  const logs: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of ["log", "error", "warn", "info"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  let id: string, g: FakeGoogle;
  try {
    ({ id, g } = await connected());
    await seed({ title: "GC4", by: id });
    assert.equal(await sync(id, g), "synced");
    g.mode = "down";
    await sync(id, g).catch((e: unknown) => logs.push(String(e instanceof Error ? `${e.message} ${e.stack}` : e)));
    g.mode = "up";
  } finally {
    Object.assign(console, orig);
  }
  const row = await conn(id);
  const refreshTokens = g.issued.filter((t) => t.startsWith("1//"));
  assert.equal(refreshTokens.length, 1);
  assert.ok(row.refresh_token_enc && !row.refresh_token_enc.includes(refreshTokens[0]), "the refresh token is not stored in plain text");
  assert.equal(decrypt(row.refresh_token_enc), refreshTokens[0], "the stored refresh token is encrypt()ed");
  for (const t of g.issued) {
    assert.ok(!JSON.stringify(row).includes(t), "no token in plain text in the google_calendars row");
    assert.ok(!logs.some((l) => l.includes(t)), "no token in the logs");
  }
  const shown = JSON.stringify(await getGoogleConnection(s.companyId, id));
  assert.ok(!/token/i.test(shown) && !g.issued.some((t) => shown.includes(t)), `getGoogleConnection shows no tokens: ${shown}`);
  assert.ok(!shown.includes(row.refresh_token_enc), "getGoogleConnection shows no sealed tokens either");
  const exported = JSON.stringify(await exportPerson(s.companyId, id));
  assert.ok(exported.includes(row.google_email), "the export says which Google account");
  assert.ok(!exported.includes(row.refresh_token_enc) && !g.issued.some((t) => exported.includes(t)), "the export has no tokens");
  const audit = JSON.stringify(await q("select changes from audit_log where company_id = $1 and object_type = 'google_calendars'", [s.companyId]));
  assert.ok(!audit.includes(row.refresh_token_enc) && !g.issued.some((t) => audit.includes(t)), "the audit log has no tokens");
});

test("GC5: disconnect deletes the NotifyHub calendar from Google and the tokens; syncing stops", async () => {
  const { id, g } = await connected();
  await seed({ title: "GC5", by: id });
  assert.equal(await sync(id, g), "synced");
  const calId = g.calendar!.id;
  const refresh = g.issued.find((t) => t.startsWith("1//"))!;
  await disconnectGoogle(s.companyId, id, g.fetch);
  assert.ok(g.deletedCalendars.includes(calId), 'the "NotifyHub" calendar is deleted from Google');
  assert.equal(g.calendars.size, 0);
  assert.equal(await conn(id), undefined, "the tokens are deleted");
  assert.equal(await getGoogleConnection(s.companyId, id), null, "Profile shows not connected");
  assert.ok(g.revoked.has(refresh) || g.calls.some((c) => c.url.startsWith(REVOKE)), "the grant is revoked at Google");

  const before = g.calls.length;
  await seed({ title: "GC5 after", by: id });
  assert.notEqual(await sync(id, g), "synced", "syncing stops");
  assert.equal(g.calls.length, before, "no Google calls after disconnecting");
  assert.ok(!(await targets()).has(id), "no longer a sync target");
});

test("GC6: access revoked at Google stops syncing, shows Reconnect, and gives one in-app notification; reconnecting works", async () => {
  const { id, g } = await connected();
  const r1 = await seed({ title: "GC6", by: id });
  assert.equal(await sync(id, g), "synced");
  g.mode = "revoked";
  await q("update google_calendars set access_expires_at = now() - interval '1 hour' where user_id = $1", [id]);
  await seed({ title: "GC6 b", by: id });
  assert.equal(await sync(id, g), "revoked");
  const row = await conn(id);
  assert.equal(row?.status, "revoked", "the connection is marked revoked");
  const c = (await getGoogleConnection(s.companyId, id)) as { status?: string } | null;
  assert.equal(c?.status, "revoked", "Profile can say Reconnect");

  const callsAfter = g.calls.length;
  await seed({ title: "GC6 c", by: id });
  assert.notEqual(await sync(id, g), "synced", "syncing stays stopped");
  assert.equal(g.calls.filter((x, i) => i >= callsAfter && x.url.startsWith(API)).length, 0, "no Calendar calls while revoked");
  const notes = await q("select kind, text from notifications where user_id = $1 and kind = 'calendar'", [id]);
  assert.equal(notes.length, 1, `exactly one in-app notification: ${JSON.stringify(notes)}`);

  // Reconnect.
  g.mode = "up";
  assert.equal(await connectGoogle(s.companyId, id, g.code("again@gmail.com"), g.fetch), null, "reconnecting works");
  assert.equal((await conn(id))?.status, "active");
  assert.equal(await sync(id, g), "synced");
  assert.ok([...g.calendars.values()].some((cal) => cal.events.has(googleEventId(r1))), "syncing resumes");
});

test("GC7: an admin blocking Google Calendar refuses new connections and removes existing ones and their calendars", async () => {
  const s2 = seeder();
  await s2.company();
  const u1 = await s2.user({ roles: [MEMBER_ROLE_ID] });
  const u2 = await s2.user({ roles: [MEMBER_ROLE_ID] });
  try {
    assert.equal(await googleAllowed(s2.companyId), true, "allowed by default");
    const g = new FakeGoogle();
    assert.equal(await connectGoogle(s2.companyId, u1, g.code("u1@gmail.com"), g.fetch), null);
    assert.equal(await syncGoogle(u1, g.fetch, NOW), "synced");
    const calId = g.calendar!.id;

    await setGoogleCalendarEnabled(s2.companyId, false);
    assert.equal(await googleAllowed(s2.companyId), false);
    const g2 = new FakeGoogle();
    const err = await connectGoogle(s2.companyId, u2, g2.code("u2@gmail.com"), g2.fetch);
    assert.equal(typeof err, "string", "connecting is refused while blocked");
    assert.equal((await s2.owner.query("select 1 from google_calendars where user_id = $1", [u2])).rowCount, 0, "nothing stored");

    assert.ok((await targets()).has(u1), "the worker picks up the existing connection to remove it");
    assert.equal(await syncGoogle(u1, g.fetch, NOW), "removed");
    assert.ok(g.deletedCalendars.includes(calId), "its NotifyHub calendar is deleted from Google");
    assert.equal((await s2.owner.query("select 1 from google_calendars where user_id = $1", [u1])).rowCount, 0, "the connection is gone");
    assert.ok(!(await targets()).has(u1), "no longer a sync target");
  } finally {
    await s2.owner.query("delete from google_calendars where company_id = $1", [s2.companyId]);
    await s2.cleanup();
  }
});

test("GC8: a deactivated person stops syncing; erasing deletes the tokens and (best effort) the calendar", async () => {
  const { id, g } = await connected();
  await seed({ title: "GC8", by: id });
  assert.equal(await sync(id, g), "synced");
  assert.equal(await setActive(await actor(admin), s.companyId, id, false), null);
  const eventWrites = () => g.writes.filter((w) => w.url.includes("/events")).length;
  const before = eventWrites();
  await seed({ title: "GC8 b", by: id });
  assert.notEqual(await sync(id, g), "synced", "a deactivated person is not synced");
  assert.equal(eventWrites(), before, "no event writes after deactivating");

  // Erase: the calendar is removed best effort, with the global fetch.
  const realFetch = globalThis.fetch;
  globalThis.fetch = g.fetch;
  try {
    const e = await erasePerson(await actor(admin), s.companyId, id);
    assert.equal(e, null, `erasePerson: ${e}`);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(await conn(id), undefined, "erasing deletes the tokens");
  assert.equal(g.calendars.size, 0, "erasing deletes the NotifyHub calendar (best effort)");
});

// --- What's synced --------------------------------------------------------------

test("GC9: what I created or what is addressed to me (a plain reminder once it's sent; tasks and events ahead), not everything an admin can open", async () => {
  const { id: me, g } = await connected({ roles: [COMPANY_ADMIN_ROLE_ID] });
  const bob = await s.user({ roles: [MEMBER_ROLE_ID] });
  const dept = await department(me, olga);
  const grp = await group(me);
  const ways: [string, [string, string | null][]][] = [
    ["directly", [["user", me]]],
    ["via my department", [["department", dept]]],
    ["via my group", [["group", grp]]],
    ["via the company", [["company", null]]],
  ];
  const SENT = at("2031-05-25T09:00:00Z");
  const yes: [string, string][] = [];
  const no: [string, string][] = [];
  yes.push([await seed({ title: "GC9 created by me", by: me, targets: [["user", bob]] }), "a scheduled reminder I created"]);
  yes.push([await seed({ title: "GC9 task created by me", by: me, isTask: true, targets: [["user", bob]] }), "a scheduled task I created"]);
  const scheduledToMe: string[] = [];
  for (const [how, targets] of ways) {
    const r = await seed({ title: `GC9 reminder ${how}`, targets });
    scheduledToMe.push(r);
    no.push([r, `a scheduled plain reminder to me ${how}`]);
    const sent = await seed({ title: `GC9 sent reminder ${how}`, status: "sent", sendAt: SENT, targets });
    await delivered(sent, me, SENT);
    yes.push([sent, `a sent reminder to me ${how}`]);
    yes.push([await seed({ title: `GC9 task ${how}`, isTask: true, targets }), `a scheduled task to me ${how}`]);
    yes.push([await seed({ title: `GC9 event ${how}`, isEvent: true, targets }), `a scheduled event for me ${how}`]);
  }
  no.push([await seed({ title: "GC9 olga to bob", targets: [["user", bob]] }), "someone else's reminder to someone else (an admin could open it)"]);
  no.push([await seed({ title: "GC9 olga's task to bob", isTask: true, targets: [["user", bob]] }), "someone else's task to someone else"]);
  no.push([await seed({ title: "GC9 olga's event for bob", isEvent: true, targets: [["user", bob]] }), "someone else's event for someone else"]);
  const sentToBob = await seed({ title: "GC9 sent to bob", status: "sent", sendAt: SENT, targets: [["user", bob]] });
  await delivered(sentToBob, bob, SENT);
  no.push([sentToBob, "a reminder sent to someone else"]);
  no.push([await seed({ title: "GC9 to another dept", targets: [["department", await department(olga, bob)]] }), "to a department I'm not in"]);
  assert.equal(await sync(me, g), "synced");
  const missing = yes.filter(([rid]) => !eventIn(g, rid)).map(([, label]) => label);
  const extra = no.filter(([rid]) => eventIn(g, rid)).map(([, label]) => label);
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `missing: ${missing.join("; ")} | extra: ${extra.join("; ")}`);

  // A plain reminder addressed to me appears once it's sent.
  for (const r of scheduledToMe) {
    await q("update reminders set status = 'sent', send_at = $2, updated_at = now() where id = $1", [r, SENT]);
    await delivered(r, me, SENT);
  }
  assert.equal(await sync(me, g), "synced");
  const stillMissing = scheduledToMe.filter((r) => !eventIn(g, r)).map((r, i) => ways[i][0]);
  assert.deepEqual(stillMissing, [], `once sent, a plain reminder to me appears: missing ${stillMissing.join(", ")}`);
});

test("GC10: scheduled, paused series and sent are synced; waiting for approval, rejected, cancelled and deleted are not", async () => {
  const { id: me, g } = await connected();
  const WEEKLY = { freq: "weekly", interval: 1, weekdays: [0], end: { type: "never" } };
  const yes = {
    scheduled: await seed({ title: "GC10 scheduled", by: me }),
    paused: await seed({ title: "GC10 paused", status: "paused", recurrence: WEEKLY, sendAt: at("2031-06-02T09:00:00Z"), by: me }),
    sent: await seed({ title: "GC10 sent", status: "sent", sendAt: at("2031-05-20T09:00:00Z"), targets: [["user", me]] }),
  };
  await delivered(yes.sent, me, at("2031-05-20T09:00:00Z"));
  const no = {
    pending_approval: await seed({ title: "GC10 waiting", status: "pending_approval", by: me }),
    rejected: await seed({ title: "GC10 rejected", status: "rejected", by: me }),
    cancelled: await seed({ title: "GC10 cancelled", status: "cancelled", by: me }),
    deleted: await seed({ title: "GC10 deleted", status: "cancelled", deleted: true, by: me }),
    deletedScheduled: await seed({ title: "GC10 deleted (scheduled)", deleted: true, by: me }),
  };
  assert.equal(await sync(me, g), "synced");
  const missing = Object.entries(yes).filter(([, rid]) => !eventIn(g, rid)).map(([k]) => k);
  const extra = Object.entries(no).filter(([, rid]) => eventIn(g, rid)).map(([k]) => k);
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `synced states wrong: missing ${missing.join(", ")}; extra ${extra.join(", ")}`);
});

test("GC11: from 30 days ago to a year ahead; the first sync fills that range", async () => {
  const { id: me, g } = await connected();
  const inside = [
    await seed({ title: "GC11 29 days ago", status: "sent", sendAt: new Date(NOW.getTime() - 29 * DAY), by: me }),
    await seed({ title: "GC11 tomorrow", sendAt: new Date(NOW.getTime() + DAY), by: me }),
    await seed({ title: "GC11 in 360 days", sendAt: new Date(NOW.getTime() + 360 * DAY), by: me }),
  ];
  const outside = [
    await seed({ title: "GC11 31 days ago", status: "sent", sendAt: new Date(NOW.getTime() - 31 * DAY), by: me }),
    await seed({ title: "GC11 in 370 days", sendAt: new Date(NOW.getTime() + 370 * DAY), by: me }),
  ];
  assert.equal(await sync(me, g), "synced", "the first sync");
  for (const rid of inside) assert.ok(eventIn(g, rid), "inside the range: synced by the first sync");
  for (const rid of outside) assert.equal(eventIn(g, rid), undefined, "outside the range: not synced");
});

test("GC12: a reminder or task is 30 minutes at its send time, with title, description and a link back, and no recipient list", async () => {
  const { id: me, g } = await connected();
  const bob = await s.user({ roles: [MEMBER_ROLE_ID] });
  await q(`update "user" set name = 'Bob Recipient' where id = $1`, [bob]);
  const sendAt = at("2031-07-03T14:15:00Z");
  const rem = await seed({ title: "GC12 pay slips", description: "Upload them by noon", sendAt, by: me, targets: [["user", bob]] });
  const task = await seed({ title: "GC12 task", description: "Do it", sendAt, isTask: true, by: me, targets: [["user", bob]] });
  assert.equal(await sync(me, g), "synced");
  const [{ short_id: remShort }] = await q("select short_id from reminders where id = $1", [rem]);
  const [{ short_id: taskShort }] = await q("select short_id from reminders where id = $1", [task]);
  for (const [rid, short, title, desc] of [[rem, remShort, "GC12 pay slips", "Upload them by noon"], [task, taskShort, "GC12 task", "Do it"]]) {
    const e = eventIn(g, rid);
    assert.ok(e, `synced with the stable id ${googleEventId(rid)}`);
    assert.ok(e.summary?.includes(title), `the title: ${e.summary}`);
    assert.ok(e.start?.dateTime && e.end?.dateTime, "a timed entry");
    assert.equal(Date.parse(e.start.dateTime), sendAt.getTime(), "at its send time");
    assert.equal(Date.parse(e.end.dateTime) - Date.parse(e.start.dateTime), 30 * MIN, "30 minutes long");
    assert.ok(e.description?.includes(desc), "the description");
    const json = JSON.stringify(e);
    assert.ok(json.includes(APP) && (json.includes(rid) || json.includes(short)), `a link back to the entry in NotifyHub: ${e.description}`);
    assert.ok(!e.attendees || e.attendees.length === 0, "no attendees");
    assert.ok(!json.includes(emailOf(bob)) && !json.includes(bob) && !json.includes("Bob Recipient"), "no recipient list");
  }
});

test("GC13: an event has its real start and end (or all day), place and meeting link", async () => {
  const { id: me, g } = await connected();
  const timed = await seed({
    title: "GC13 offsite",
    isEvent: true,
    sendAt: at("2031-07-10T09:30:00Z"),
    duration: 150,
    location: "Room 7",
    meetingUrl: "https://meet.example.com/gc13-xyz",
    targets: [["user", me]],
  });
  const allDay = await seed({ title: "GC13 all day", isEvent: true, allDay: true, sendAt: at("2031-07-11T00:00:00Z"), anchor: "2031-07-11T00:00", duration: 1440, targets: [["user", me]] });
  const twoDays = await seed({ title: "GC13 two days", isEvent: true, allDay: true, sendAt: at("2031-07-14T00:00:00Z"), anchor: "2031-07-14T00:00", duration: 2880, targets: [["user", me]] });
  assert.equal(await sync(me, g), "synced");
  const e = eventIn(g, timed);
  assert.ok(e?.start?.dateTime && e.end?.dateTime, "the event is synced, timed");
  assert.equal(Date.parse(e.start.dateTime), at("2031-07-10T09:30:00Z").getTime(), "its real start");
  assert.equal(Date.parse(e.end.dateTime), at("2031-07-10T12:00:00Z").getTime(), "its real end");
  assert.equal(e.location, "Room 7", "the place");
  assert.ok(JSON.stringify(e).includes("https://meet.example.com/gc13-xyz"), "the meeting link");
  const a = eventIn(g, allDay);
  assert.deepEqual([a?.start?.date, a?.end?.date], ["2031-07-11", "2031-07-12"], "all day (Google's end date is exclusive)");
  assert.equal(a?.start?.dateTime, undefined);
  const b = eventIn(g, twoDays);
  assert.deepEqual([b?.start?.date, b?.end?.date], ["2031-07-14", "2031-07-16"], "a two-day all-day event");
});

test("GC14: a repeating one is one recurring entry with its rule, minus skipped and moved dates", async () => {
  const { id: me, g } = await connected();
  const WEEKLY = { freq: "weekly", interval: 1, weekdays: [0], end: { type: "never" } };
  const series = await seed({ title: "GC14 weekly", recurrence: WEEKLY, sendAt: at("2031-06-02T09:00:00Z"), anchor: "2031-06-02T09:00", by: me });
  await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, $3, 'skipped')", [s.companyId, series, at("2031-06-09T09:00:00Z")]);
  const moved = await seed({ title: "GC14 moved copy", sendAt: at("2031-06-17T11:00:00Z"), replaces: [series, at("2031-06-16T09:00:00Z")], by: me });
  assert.equal(await sync(me, g), "synced");
  const e = eventIn(g, series);
  assert.ok(e, "the series is synced");
  const weekly = [...g.calendar!.events.values()].filter((x) => x.summary?.includes("GC14 weekly"));
  assert.equal(weekly.length, 1, "one entry for the whole series, not one per date");
  const rec = (e.recurrence ?? []).join("\n");
  assert.match(rec, /RRULE:[^\n]*FREQ=WEEKLY/, `its repeat rule: ${rec}`);
  assert.match(rec, /BYDAY=MO/, "on Mondays");
  const ex = rec.split("\n").filter((l) => l.startsWith("EXDATE")).join("\n");
  assert.match(ex, /20310609/, `the skipped date is left out: ${rec}`);
  assert.match(ex, /20310616/, `the moved date is left out: ${rec}`);
  assert.doesNotMatch(ex, /20310602|20310623/, "other dates stay");
  assert.ok(eventIn(g, moved), "the moved copy is its own entry");
  // googleEvent itself: the exdates passed in end up as EXDATEs.
  const body = googleEvent(
    { id: series, title: "x", description: "", sendAt: at("2031-06-02T09:00:00Z"), recurrence: WEEKLY as never, anchorLocal: "2031-06-02T09:00", timeZone: "UTC", isEvent: false, isTask: false, durationMinutes: null, allDay: false, location: null, meetingUrl: null },
    APP,
    ["2031-06-09T09:00:00.000Z"],
  ) as { recurrence?: string[] };
  assert.match((body.recurrence ?? []).join("\n"), /EXDATE[^\n]*20310609/);
});

test("GC15: an event I said No to is removed from my Google calendar, and back if I change my answer", async () => {
  const { id: me, g } = await connected();
  const ev = await seed({ title: "GC15 event", isEvent: true, sendAt: at("2031-07-20T09:00:00Z"), targets: [["user", me]] });
  assert.equal(await sync(me, g), "synced");
  assert.ok(eventIn(g, ev), "synced while unanswered");
  assert.equal(await respond(s.companyId, me, ev, "no", me, NOW), null);
  assert.ok((await targets()).has(me), "answering is a change to sync");
  assert.equal(await sync(me, g), "synced");
  assert.equal(eventIn(g, ev), undefined, "removed after No");
  assert.equal(await respond(s.companyId, me, ev, "maybe", me, NOW), null);
  assert.equal(await sync(me, g), "synced");
  assert.ok(eventIn(g, ev), "back after changing to Maybe");
});

test("GC16: a change in NotifyHub (new, edit, drag, cancel, delete, joining a department) is picked up once and reflected; retried if Google is down", async () => {
  const { id: me, g } = await connected();
  assert.equal(await sync(me, g), "synced", "the first sync");
  const writes = () => g.writes.filter((w) => w.url.includes("/events")).length;
  const before = writes();
  assert.equal(await sync(me, g), "synced");
  assert.equal(writes(), before, "nothing written to Google when nothing changed");

  // Picked up by the next tick, written, then nothing more for the same change.
  const step = async (what: string, check: () => void) => {
    assert.ok((await targets()).has(me), `${what}: picked up for syncing`);
    assert.equal(await sync(me, g), "synced", what);
    check();
    const n = writes();
    assert.equal(await sync(me, g), "synced");
    assert.equal(writes(), n, `${what}: written once per change`);
  };
  const a = await create({ title: "GC16 new", users: [me], isEvent: true });
  await step("a new event for me", () => assert.ok(eventIn(g, a)?.summary?.includes("GC16 new")));

  assert.equal(await updateReminder(await actor(admin), s.companyId, a, input({ title: "GC16 edited", users: [me], isEvent: true }), []), null);
  await step("an edit", () => assert.ok(eventIn(g, a)?.summary?.includes("GC16 edited")));

  const moved = await moveEntry(await actor(admin), s.companyId, a, at("2031-07-01T09:00:00Z"), at("2031-07-02T15:00:00Z"), "one", NOW);
  assert.ok(moved === null || typeof moved !== "string", `moveEntry: ${JSON.stringify(moved)}`);
  await step("a drag", () => assert.equal(Date.parse(eventIn(g, a)!.start!.dateTime!), at("2031-07-02T15:00:00Z").getTime()));

  const b = await create({ title: "GC16 to cancel", users: [me], isEvent: true });
  assert.equal(await sync(me, g), "synced");
  assert.ok(eventIn(g, b));
  assert.equal(await cancelReminder(await actor(admin), s.companyId, b), null);
  await step("a cancel", () => assert.equal(eventIn(g, b), undefined));

  // (A fresh one: the live worker may still be sending the first one's invites and updates.)
  const del = await seed({ title: "GC16 to delete", isEvent: true, by: admin, targets: [["user", me]] });
  assert.equal(await sync(me, g), "synced");
  assert.ok(eventIn(g, del));
  assert.equal(await deleteReminder(await actor(admin), s.companyId, del), null);
  await step("a delete", () => assert.equal(eventIn(g, del), undefined));

  const dept = await department(olga);
  const d = await seed({ title: "GC16 to the department", isEvent: true, targets: [["department", dept]] });
  assert.equal(await sync(me, g), "synced");
  assert.equal(eventIn(g, d), undefined, "not mine before joining");
  assert.equal(await addMember(await actor(admin), s.companyId, dept, me), null);
  await step("joining a department", () => assert.ok(eventIn(g, d), "the department's reminder appears"));

  // Google down: the change isn't lost.
  const c = await create({ title: "GC16 while down", users: [me], isEvent: true });
  g.mode = "down";
  let threw = false;
  const r = await sync(me, g).catch(() => ((threw = true), null));
  g.mode = "up";
  assert.ok(threw || (await targets()).has(me), `retried: the sync throws (job retry) or stays a target (said ${r})`);
  assert.equal(await sync(me, g), "synced");
  assert.ok(eventIn(g, c)?.summary?.includes("GC16 while down"), "reflected once Google is back");
});

test("GC17: edits in Google aren't brought back; the next change in NotifyHub overwrites them; the description says so", async () => {
  const { id: me, g } = await connected();
  const a = await create({ title: "GC17 original", users: [me], isEvent: true });
  const b = await create({ title: "GC17 deleted in Google", users: [me], isEvent: true });
  assert.equal(await sync(me, g), "synced");
  const e = eventIn(g, a)!;
  assert.match(e.description ?? "", /(overwrit|replaced|won.t (be )?(kept|saved|synced)|not (be )?(kept|saved|synced|brought back)|aren.t (kept|saved|synced|brought back)|edit[^.]*in NotifyHub)/i, `a note that edits in Google aren't kept: ${e.description}`);

  g.calendar!.events.set(e.id, { ...e, summary: "changed in Google" });
  g.calendar!.events.delete(googleEventId(b));
  const [{ title }] = await q("select title from reminders where id = $1", [a]);
  assert.equal(title, "GC17 original", "not brought back into NotifyHub");

  assert.equal(await updateReminder(await actor(admin), s.companyId, a, input({ title: "GC17 next change", users: [me], isEvent: true }), []), null);
  assert.equal(await updateReminder(await actor(admin), s.companyId, b, input({ title: "GC17 back", users: [me], isEvent: true }), []), null);
  assert.equal(await sync(me, g), "synced");
  assert.ok(eventIn(g, a)?.summary?.includes("GC17 next change"), "the next change overwrites the edit made in Google");
  assert.ok(eventIn(g, b)?.summary?.includes("GC17 back"), "an entry deleted in Google comes back on the next change");
});

test("GC18: event invites are still sent to connected people, and the event is in their NotifyHub calendar too", async () => {
  const { id: me, g } = await connected();
  const ev = await create({ title: "GC18 event", users: [me], isEvent: true, start: "2031-07-21T09:00" });
  await dispatchInvites(async () => {}, s.companyId);
  const inv = await q("select channel from deliveries where reminder_id = $1 and user_id = $2 and kind = 'invite'", [ev, me]);
  assert.ok(inv.some((d) => d.channel === "email"), "the email invite is still queued");
  assert.equal(await sync(me, g), "synced");
  assert.ok(eventIn(g, ev), "and it is in the NotifyHub calendar");
});
