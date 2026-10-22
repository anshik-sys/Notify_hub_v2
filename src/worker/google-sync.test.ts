import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { encrypt } from "@/lib/crypto";
import { googleEventId } from "@/lib/google";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { syncGoogle } from "./google-sync";

// Section 13 from the worker, against an in-memory fake Google.
const s = seeder();
let me: string, other: string, ops: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

function fakeGoogle(opts: { revoked?: boolean } = {}) {
  const calendars = new Map<string, Map<string, { summary: string; status: string }>>();
  const calls: string[] = [];
  let n = 0;
  const f = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const json = (b: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(b), { status });
    if (url.pathname === "/token")
      return opts.revoked ? json({ error: "invalid_grant" }, 400) : json({ access_token: "acc", expires_in: 3600 });
    if (url.pathname === "/revoke") return json({});
    const m = /^\/calendar\/v3\/calendars(?:\/([^/]+))?(?:\/events(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (!m) return json({ error: { status: "NOT_FOUND" } }, 404);
    const [, cal, ev] = m.map((x) => (x ? decodeURIComponent(x) : x));
    calls.push(`${method} ${ev ? "event" : "calendar"}`);
    if (!cal && method === "POST") {
      const id = `cal${++n}@group.calendar.google.com`;
      calendars.set(id, new Map());
      return json({ id });
    }
    const events = calendars.get(cal!);
    if (!events) return json({ error: { status: "NOT_FOUND" } }, 404);
    if (!url.pathname.includes("/events") && method === "DELETE") return (calendars.delete(cal!), json(null, 204));
    const body = init?.body ? (JSON.parse(init.body as string) as { id: string; summary: string; status: string }) : null;
    if (method === "PUT") {
      if (!events.has(ev!)) return json({ error: { status: "NOT_FOUND" } }, 404);
      events.set(ev!, body!);
      return json(body);
    }
    if (method === "POST") return (events.set(body!.id, body!), json(body));
    if (method === "DELETE") return (events.set(ev!, { ...events.get(ev!)!, status: "cancelled" }), json(null, 204));
    return json({ error: { status: "NOT_FOUND" } }, 404);
  }) as unknown as typeof fetch;
  // What's live in Google: not deleted ("cancelled").
  const live = () => [...calendars.values()].flatMap((evs) => [...evs.entries()].filter(([, e]) => e.status !== "cancelled").map(([id, e]) => ({ id, summary: e.summary })));
  return { f, calendars, calls, live };
}

let k = 0;
async function reminder(over: { createdBy?: string; status?: string; isEvent?: boolean; target?: string; title?: string } = {}) {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_event, duration_minutes)
     values ($1, $2, $3, $4, 'S', now() + interval '2 days', $5, 'UTC', '2031-01-01T00:00', $6, $7) returning id`,
    [s.companyId, `G-${s.companyId.slice(0, 6)}-${k++}`, over.createdBy ?? other, over.title ?? `R${k}`, over.status ?? "scheduled", over.isEvent ?? false, over.isEvent ? 60 : null],
  );
  if (over.target) await q("insert into reminder_targets values ($1, $2, 'department', $3)", [id, s.companyId, over.target]);
  return id as string;
}
const connect = (calendarId: string | null = null) =>
  q("insert into google_calendars (user_id, company_id, google_email, refresh_token_enc, calendar_id) values ($1, $2, 'me@gmail.test', $3, $4) on conflict (user_id) do update set status = 'active', calendar_id = $4", [
    me,
    s.companyId,
    encrypt("refresh"),
    calendarId,
  ]);

before(async () => {
  await s.company();
  [me, other] = [await s.user(), await s.user()];
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, me]);
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
});

test("first sync: makes the NotifyHub calendar and fills it with mine and what's addressed to me; then only changes are written", async () => {
  await connect();
  const mine = await reminder({ createdBy: me, title: "My reminder" });
  const invited = await reminder({ isEvent: true, target: ops, title: "Ops sync" });
  const notMine = await reminder({ title: "Someone else's" });
  const pending = await reminder({ createdBy: me, status: "pending_approval", title: "Waiting" });
  const declined = await reminder({ isEvent: true, target: ops, title: "Declined" });
  await q("insert into event_responses (reminder_id, user_id, company_id, answer) values ($1, $2, $3, 'no')", [declined, me, s.companyId]);
  // A plain reminder to my department isn't mine to open until it's sent (the app's rule).
  const upcomingToMe = await reminder({ target: ops, title: "Not sent yet" });

  const g = fakeGoogle();
  assert.equal(await syncGoogle(me, g.f), "synced");
  assert.equal(g.calendars.size, 1);
  assert.deepEqual(g.live().map((e) => e.summary).sort(), ["Ops sync", "Reminder: My reminder"]);
  for (const x of [notMine, pending, declined, upcomingToMe]) assert.ok(!g.live().some((e) => e.id === googleEventId(x)));

  // Nothing changed: nothing written.
  g.calls.length = 0;
  await syncGoogle(me, g.f);
  assert.deepEqual(g.calls, []);
  // A rename: that one entry only. A cancel: deleted from Google.
  await q("update reminders set title = 'Renamed' where id = $1", [mine]);
  await q("update reminders set status = 'cancelled' where id = $1", [invited]);
  await syncGoogle(me, g.f);
  assert.deepEqual(g.calls.sort(), ["DELETE event", "PUT event"]);
  assert.deepEqual(g.live().map((e) => e.summary), ["Reminder: Renamed"]);
  // Saying No takes an event out; changing the answer brings it back.
  await q("delete from event_responses where reminder_id = $1", [declined]);
  await syncGoogle(me, g.f);
  assert.ok(g.live().some((e) => e.summary === "Declined"));
});

test("they deleted the NotifyHub calendar in Google: it's made again and refilled", async () => {
  const g = fakeGoogle();
  await connect();
  await syncGoogle(me, g.f);
  const before_ = g.live().length;
  g.calendars.clear();
  await q("update reminders set title = title || '!' where created_by = $1", [me]); // a change, so the sync writes
  await syncGoogle(me, g.f);
  assert.equal(g.calendars.size, 1);
  assert.equal(g.live().length, before_);
});

test("access revoked in Google: syncing stops, Profile says reconnect, one notification (GC6)", async () => {
  await connect();
  await q("update google_calendars set access_token_enc = null where user_id = $1", [me]);
  const g = fakeGoogle({ revoked: true });
  assert.equal(await syncGoogle(me, g.f), "revoked");
  assert.equal(await syncGoogle(me, g.f), "skipped");
  assert.deepEqual(await q("select status from google_calendars where user_id = $1", [me]), [{ status: "revoked" }]);
  assert.equal((await q("select 1 from notifications where user_id = $1 and kind = 'calendar'", [me])).length, 1);
});

test("the company blocks it: the calendar is removed from Google and the connection deleted (GC7)", async () => {
  await connect();
  const g = fakeGoogle();
  await syncGoogle(me, g.f);
  assert.equal(g.calendars.size, 1);
  await q("update companies set google_calendar_enabled = false where id = $1", [s.companyId]);
  assert.equal(await syncGoogle(me, g.f), "removed");
  assert.equal(g.calendars.size, 0);
  assert.equal((await q("select 1 from google_calendars where user_id = $1", [me])).length, 0);
  await q("update companies set google_calendar_enabled = true where id = $1", [s.companyId]);
});
