// Behaviour tests for docs/expected-behaviour.md section 9 (N1–N12, more
// notification preferences), written from the spec, not the code. A failure
// means the code or the spec is wrong.
//
// Companies: `s` (no Slack) for the web-side cases, `sl` (Slack connected,
// fake fetch) for N4, `f` and `lim` for the worker cases N5 and N6 (their own
// admins), `other` for N10. Reminders are dated 2050 so a live worker never
// sends them.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { db, withTenant } from "@/db";
import { ownerDb } from "@/worker/db";
import { deliverOne, MAX_ATTEMPTS } from "@/worker/delivery";
import { authDb } from "./auth";
import { addComment } from "./comments";
import { encrypt } from "./crypto";
import type { sendMail } from "./mail";
import { getMutes, MUTABLE, mutedFor, planTell, sendTell, setMutes } from "./notifications";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import type { Target } from "./recipients";
import { createReminder, decideReminder, updateReminder } from "./reminders";
import { setDone } from "./tasks";
import { seeder } from "./test-helpers";

type Seeder = ReturnType<typeof seeder>;
const s = seeder();
const sl = seeder();
const f = seeder();
const lim = seeder();
const other = seeder();

const FAR = new Date(Date.UTC(2050, 0, 15, 9));
const emailOf = (co: Seeder, id: string) => `${id}@${co.domain}`;
const qIn = (co: Seeder) => async (sql: string, params: unknown[] = []) => (await co.owner.query(sql, params)).rows;
const q = qIn(s);
const actorIn = (co: Seeder) => async (id: string) => ({ id, name: `N-${id.slice(0, 6)}`, email: emailOf(co, id), access: await loadAccess(co.companyId, id) });
const actor = actorIn(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mail: an injected capture where the function takes one, Mailpit otherwise.
type Mail = { to: string; subject: string; text: string };
const capture = () => {
  const box: Mail[] = [];
  const send = (async (m: Mail) => void box.push(m)) as unknown as typeof sendMail;
  return { box, send, to: (addr: string) => box.filter((m) => m.to === addr) };
};
const mailpit = async (to: string) =>
  (await (await fetch(`http://localhost:8025/api/v1/search?query=to:${encodeURIComponent(to)}`)).json()).messages_count as number;
// Waits until at least `n` mails reached `to` (or the time runs out), then returns the count.
const mailpitAtLeast = async (to: string, n: number, ms = 4000) => {
  const end = Date.now() + ms;
  let c = await mailpit(to);
  while (c < n && Date.now() < end) {
    await sleep(150);
    c = await mailpit(to);
  }
  return c;
};

// --- The spec's table, matched to MUTABLE by label -------------------------------------
type Spec = { key: string; re: RegExp; channels: ("email" | "slack" | "push")[]; off: ("email" | "slack" | "push")[] };
const SPEC: Spec[] = [
  { key: "needs approval", re: /need.*approv|approv.*(need|request|wait|pending)/i, channels: ["email", "slack", "push"], off: [] },
  { key: "approved", re: /\bapproved\b/i, channels: ["email", "slack", "push"], off: ["email", "slack"] },
  { key: "rejected", re: /\brejected\b/i, channels: ["email", "slack", "push"], off: [] },
  { key: "mentioned", re: /mention/i, channels: ["email", "slack", "push"], off: [] },
  { key: "commented", re: /commented/i, channels: ["email", "slack", "push"], off: ["email", "slack"] },
  { key: "tasks done", re: /finished|everyone.*done|all.*done|completed/i, channels: ["email", "slack", "push"], off: ["email", "slack"] },
  { key: "failed", re: /fail/i, channels: ["email", "slack", "push"], off: ["slack"] },
  { key: "limit", re: /limit/i, channels: ["email", "push"], off: [] },
  { key: "late", re: /\blate\b|overdue/i, channels: ["email", "slack", "push"], off: [] },
  // Added with events (section 11, RS7). Push on every event, starting on: section 16, PU8.
  { key: "answered", re: /answered/i, channels: ["email", "slack", "push"], off: ["email", "slack"] },
];
const listed = () => MUTABLE.map((m) => `${m.event} "${m.label}" [${m.channels}] off [${m.off}]`).join("; ");
const ev = (key: Spec["key"]) => {
  const spec = SPEC.find((x) => x.key === key)!;
  const hits = MUTABLE.filter((m) => spec.re.test(m.label));
  assert.equal(hits.length, 1, `exactly one MUTABLE entry for "${key}"; MUTABLE is: ${listed()}`);
  return hits[0].event;
};
const allKeys = () => MUTABLE.flatMap((m) => m.channels.map((c) => `${m.event}:${c}`));
const defaultOff = () => MUTABLE.flatMap((m) => m.off.map((c) => `${m.event}:${c}`));
// Tick one key on, keeping every other default.
const tick = (co: Seeder, userId: string, ...keys: string[]) =>
  setMutes(co.companyId, userId, defaultOff().filter((k) => !keys.includes(k)));
// Untick one key, keeping every other default.
const untick = (co: Seeder, userId: string, ...keys: string[]) => setMutes(co.companyId, userId, [...defaultOff(), ...keys]);

// --- Fixtures ----------------------------------------------------------------------------
let admin: string, approver: string;
const reminder = async (o: { co?: Seeder; createdBy: string; status?: string; isTask?: boolean; targets?: [string, string | null][] }) => {
  const co = o.co ?? s;
  const [{ id }] = await qIn(co)(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes)
     values ($1, $2, $3, $4, 'HR', $5, $6, 'UTC', '2050-01-15T09:00', $7, $8) returning id`,
    [co.companyId, `R-${randomUUID().slice(0, 10)}`, o.createdBy, `Spec ${randomUUID().slice(0, 8)}`, FAR, o.status ?? "scheduled", o.isTask ?? false, o.isTask ? 60 : null],
  );
  for (const [kind, ref] of o.targets ?? [["email", `out-${randomUUID().slice(0, 8)}@ext.test`]])
    await qIn(co)("insert into reminder_targets (reminder_id, company_id, kind, ref) values ($1, $2, $3, $4)", [id, co.companyId, kind, ref]);
  return id as string;
};
const notes = async (co: Seeder, userId: string, kind?: string) =>
  (await qIn(co)("select kind, reminder_id, comment_id, text from notifications where user_id = $1 and ($2::text is null or kind = $2)", [userId, kind ?? null]));
const comment = async (by: string, reminderId: string, body = "A comment", mentionIds: string[] = [], deps: { send?: typeof sendMail; slackFetch?: typeof fetch } = {}) => {
  const r = await addComment(await actor(by), s.companyId, reminderId, { body, parentId: null, mentionIds }, deps);
  assert.ok("id" in r, `comment posted: ${JSON.stringify(r)}`);
  return r.id as string;
};
// A pending reminder made the normal way: a member sends to the whole company.
const pendingInput = (targets: Target[] = [{ kind: "company", ref: null }]) => ({
  title: `Pending ${randomUUID().slice(0, 6)}`,
  description: "",
  links: [],
  senderName: "S",
  sendAt: FAR,
  recurrence: null,
  anchorLocal: "2050-01-15T09:00",
  timeZone: "UTC",
  isTask: false,
  dueAfterMinutes: null,
  channels: ["email" as const],
  tags: [] as string[],
  shares: [],
  targets,
});
const pendingBy = async (creator: string) => {
  const r = await createReminder(await actor(creator), s.companyId, pendingInput());
  assert.ok("id" in r, JSON.stringify(r));
  assert.equal((await q("select status from reminders where id = $1", [r.id]))[0].status, "pending_approval", "control: needs approval");
  return r.id;
};

// An in-process fake Slack: emails starting "noslack" have no account.
function fakeSlack() {
  const calls: string[] = [];
  const dms: { channel: string; text: string }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    calls.push(method);
    const p = init.body as URLSearchParams;
    const json = (body: object) => new Response(JSON.stringify(body), { status: 200 });
    if (method === "users.lookupByEmail")
      return p.get("email")!.startsWith("noslack") ? json({ ok: false, error: "users_not_found" }) : json({ ok: true, user: { id: "U1" } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: "D1" } });
    if (method === "chat.postMessage") {
      dms.push({ channel: p.get("channel")!, text: p.get("text") ?? "" });
      return json({ ok: true, channel: p.get("channel"), ts: `${dms.length}.0` });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  return { fn, calls, dms };
}

before(async () => {
  for (const co of [s, sl, f, lim, other]) await co.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID, MEMBER_ROLE_ID] });
  approver = admin;
  await sl.owner.query(
    "insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'WS', $3, 'UBOT')",
    [sl.companyId, `T-${sl.companyId}`, encrypt("xoxb-test")],
  );
});
after(async () => {
  for (const co of [other, lim, f, sl, s]) await co.cleanup();
  await authDb.$client.end();
  await db.$client.end();
  await ownerDb.$client.end();
});

// --- Tests -------------------------------------------------------------------------------

test("N1: the preferences list has every event in the table with its channels and default-off choices; a new person's choices show the defaults", async () => {
  assert.equal(MUTABLE.length, SPEC.length, `${SPEC.length} events; MUTABLE is: ${listed()}`);
  for (const spec of SPEC) {
    const event = ev(spec.key);
    const entry = MUTABLE.find((m) => m.event === event)!;
    assert.deepEqual([...entry.channels].sort(), [...spec.channels].sort(), `${spec.key}: channels`);
    assert.deepEqual([...entry.off].sort(), [...spec.off].sort(), `${spec.key}: channels that start off`);
  }
  const fresh = await s.user({ roles: [MEMBER_ROLE_ID] });
  assert.deepEqual([...(await getMutes(s.companyId, fresh))].sort(), defaultOff().sort(), "current choice = the defaults");
  // (The ticks on the page itself are a browser check.)
});

test("N2: someone who never opened Preferences gets exactly the defaults: no comment or approval email, a rejection email", async () => {
  const fresh = await s.user({ roles: [MEMBER_ROLE_ID] });
  assert.deepEqual([...(await getMutes(s.companyId, fresh))].sort(), defaultOff().sort());

  // Commented on (off by default): no email.
  const mine = await reminder({ createdBy: fresh });
  const mail = capture();
  await comment(admin, mine, "Looks good", [], { send: mail.send });
  assert.equal(mail.to(emailOf(s, fresh)).length, 0, "no comment email");

  // Rejected (on by default): an email. Approved (off by default): none.
  const r1 = await pendingBy(fresh);
  assert.equal(await decideReminder({ id: approver, access: await loadAccess(s.companyId, approver) }, s.companyId, r1, false, "Not now"), null);
  assert.equal(await mailpitAtLeast(emailOf(s, fresh), 1), 1, "one rejection email");
  const r2 = await pendingBy(fresh);
  assert.equal(await decideReminder({ id: approver, access: await loadAccess(s.companyId, approver) }, s.companyId, r2, true), null);
  await sleep(1500);
  assert.equal(await mailpit(emailOf(s, fresh)), 1, "no approval email (still only the rejection)");
  // And mutedFor agrees: off-by-default events are muted, on-by-default ones aren't.
  const muted = await withTenant(s.companyId, (tx) => mutedFor(tx, [fresh], ev("commented")));
  assert.ok(muted.has(`${fresh}:email`) && muted.has(`${fresh}:slack`), "comment: both channels muted by default");
  const notMuted = await withTenant(s.companyId, (tx) => mutedFor(tx, [fresh], ev("rejected")));
  assert.equal(notMuted.size, 0, "rejected: nothing muted by default");
});

test("N3: with 'commented' ticked by email, the creator gets one email linking to the comment; none for their own comment", async () => {
  const creator = await s.user({ roles: [MEMBER_ROLE_ID] });
  await tick(s, creator, `${ev("commented")}:email`);
  const rid = await reminder({ createdBy: creator });
  const mail = capture();
  const cid = await comment(admin, rid, "Please check the date", [], { send: mail.send });
  const got = mail.to(emailOf(s, creator));
  assert.equal(got.length, 1, `one email to the creator; all mail: ${JSON.stringify(mail.box.map((m) => m.to))}`);
  const json = JSON.stringify(got[0]);
  assert.ok(json.includes(rid) || json.includes((await q("select short_id from reminders where id = $1", [rid]))[0].short_id), "links to the reminder");
  assert.ok(json.includes(cid), `links to the comment itself (${cid}): ${json.slice(0, 400)}`);
  assert.equal(mail.to(emailOf(s, admin)).length, 0, "the commenter gets nothing");

  const own = capture();
  await comment(creator, rid, "My own note", [], { send: own.send });
  assert.equal(own.to(emailOf(s, creator)).length, 0, "no email for their own comment");
});

test("N4: 'commented' by Slack DM: one DM when Slack is connected; no Slack account or no connection: no DM, nothing fails", async () => {
  // Slack connected, creator on Slack.
  const creator = await sl.user({ roles: [MEMBER_ROLE_ID] });
  const slAdmin = await sl.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  await tick(sl, creator, `${ev("commented")}:slack`);
  const rid = await reminder({ co: sl, createdBy: creator });
  const slack = fakeSlack();
  const mail = capture();
  const r = await addComment(await actorIn(sl)(slAdmin), sl.companyId, rid, { body: "Hello", parentId: null, mentionIds: [] }, { send: mail.send, slackFetch: slack.fn });
  assert.ok("id" in r, JSON.stringify(r));
  assert.equal(slack.dms.length, 1, `one DM (calls: ${slack.calls.join(", ")})`);
  assert.equal(mail.to(emailOf(sl, creator)).length, 0, "email not ticked: no email");

  // Slack connected, creator has no Slack account: no DM, comment still posted.
  const noSlack = await sl.user({ roles: [MEMBER_ROLE_ID], email: `noslack-${randomUUID()}@${sl.domain}` });
  await tick(sl, noSlack, `${ev("commented")}:slack`);
  const rid2 = await reminder({ co: sl, createdBy: noSlack });
  const slack2 = fakeSlack();
  const r2 = await addComment(await actorIn(sl)(slAdmin), sl.companyId, rid2, { body: "Hi", parentId: null, mentionIds: [] }, { send: capture().send, slackFetch: slack2.fn });
  assert.ok("id" in r2, `nothing fails: ${JSON.stringify(r2)}`);
  assert.equal(slack2.dms.length, 0, "no DM");

  // No Slack connection: no Slack call at all, nothing fails.
  const c3 = await s.user({ roles: [MEMBER_ROLE_ID] });
  await tick(s, c3, `${ev("commented")}:slack`);
  const rid3 = await reminder({ createdBy: c3 });
  const slack3 = fakeSlack();
  await comment(admin, rid3, "Hey", [], { send: capture().send, slackFetch: slack3.fn });
  assert.equal(slack3.dms.length, 0, "no DM");
  const plan = await withTenant(s.companyId, (tx) =>
    planTell(tx, s.companyId, [c3], ev("commented"), { subject: "x", text: "y", link: { label: "Open", url: "http://localhost/x" } }),
  );
  assert.equal(plan.slack, null, "no Slack in the plan without a connection");
  await sendTell(plan, capture().send, slack3.fn);
  assert.equal(slack3.dms.length, 0, "sending the plan makes no DM");
});

test("N5: 'deliveries failed' unticked by email: that admin gets it in-app only; the creator and other admins still get the email", async () => {
  const creator = await f.user({ roles: [MEMBER_ROLE_ID] });
  const quiet = await f.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  const loud = await f.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  await untick(f, quiet, `${ev("failed")}:email`);
  const rid = await reminder({ co: f, createdBy: creator, status: "sending" });
  const fq = qIn(f);
  const [{ id: occ }] = await fq("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, $3, 'sending') returning id", [
    f.companyId,
    rid,
    FAR,
  ]);
  const bad = `bad-${randomUUID().slice(0, 8)}@ext.test`;
  const [{ id: del }] = await fq(
    "insert into deliveries (company_id, reminder_id, occurrence_id, address, attempts) values ($1, $2, $3, $4, $5) returning id",
    [f.companyId, rid, occ, bad, MAX_ATTEMPTS - 1],
  );
  const mail = capture();
  const send = (async (m: Mail) => {
    if (m.to === bad) throw new Error("SMTP down");
    mail.box.push(m);
  }) as unknown as typeof sendMail;
  assert.equal(await deliverOne(del, send), "failed");
  const count = async (id: string, n: number) => mail.to(emailOf(f, id)).length + (await mailpitAtLeast(emailOf(f, id), n - mail.to(emailOf(f, id)).length));
  assert.equal(await count(creator, 1), 1, "creator emailed (on by default)");
  assert.equal(await count(loud, 1), 1, "the admin who left it on is emailed");
  assert.equal(mail.to(emailOf(f, quiet)).length + (await mailpit(emailOf(f, quiet))), 0, "the admin who unticked it: no email");
  for (const id of [creator, quiet, loud]) assert.equal((await notes(f, id, "failed")).length, 1, "in-app for everyone");
});

test("N6: 'daily email limit reached' unticked: that admin gets no email but still sees it in Notifications", async () => {
  const lq = qIn(lim);
  const creator = await lim.user({ roles: [MEMBER_ROLE_ID] });
  const quiet = await lim.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  const loud = await lim.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  await untick(lim, quiet, `${ev("limit")}:email`);
  await lq("update companies set daily_email_limit = 1 where id = $1", [lim.companyId]);
  const rid = await reminder({ co: lim, createdBy: creator, status: "sending" });
  const [{ id: occ }] = await lq("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, $3, 'sending') returning id", [
    lim.companyId,
    rid,
    FAR,
  ]);
  // One email already sent in the last 24 hours fills the limit of 1.
  await lq("insert into deliveries (company_id, reminder_id, occurrence_id, address, status, sent_at) values ($1, $2, $3, $4, 'sent', now())", [
    lim.companyId,
    rid,
    occ,
    `sent-${randomUUID().slice(0, 8)}@ext.test`,
  ]);
  const [{ id: del }] = await lq("insert into deliveries (company_id, reminder_id, occurrence_id, address) values ($1, $2, $3, $4) returning id", [
    lim.companyId,
    rid,
    occ,
    `held-${randomUUID().slice(0, 8)}@ext.test`,
  ]);
  const mail = capture();
  assert.equal(await deliverOne(del, mail.send), "held", "control: held by the limit");
  const loudMail = mail.to(emailOf(lim, loud)).length;
  assert.equal(loudMail + (await mailpitAtLeast(emailOf(lim, loud), 1 - loudMail)), 1, "the admin who left it on is emailed");
  assert.equal(mail.to(emailOf(lim, quiet)).length + (await mailpit(emailOf(lim, quiet))), 0, "the admin who unticked it: no email");
  for (const id of [quiet, loud]) {
    const n = (await notes(lim, id)).filter((x) => /limit/i.test(x.text as string));
    assert.equal(n.length, 1, "still in Notifications");
  }
  // Release the held row so nothing is left waiting.
  await lq("update deliveries set status = 'failed' where id = $1", [del]);
});

test("N7: with everything turned off, events are still written to Notifications", async () => {
  const p = await s.user({ roles: [MEMBER_ROLE_ID] });
  await setMutes(s.companyId, p, allKeys());
  assert.deepEqual([...(await getMutes(s.companyId, p))].sort(), allKeys().sort(), "control: all off");

  const rid = await reminder({ createdBy: p });
  const mail = capture();
  const cid = await comment(admin, rid, "In-app please", [], { send: mail.send });
  assert.ok((await notes(s, p)).some((n) => n.comment_id === cid), "comment: in Notifications");

  const ok = await pendingBy(p);
  assert.equal(await decideReminder({ id: approver, access: await loadAccess(s.companyId, approver) }, s.companyId, ok, true), null);
  const no = await pendingBy(p);
  assert.equal(await decideReminder({ id: approver, access: await loadAccess(s.companyId, approver) }, s.companyId, no, false, "No"), null);
  const all = await notes(s, p);
  assert.ok(all.some((n) => n.reminder_id === ok), "approval: in Notifications");
  assert.ok(all.some((n) => n.reminder_id === no), "rejection: in Notifications");

  // Mentioned on someone else's reminder that p (and a control person with
  // the defaults) was sent.
  const ctrl = await s.user({ roles: [MEMBER_ROLE_ID] });
  const theirs = await reminder({ createdBy: admin, status: "sent", targets: [["user", p], ["user", ctrl]] });
  const [{ id: tOcc }] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, $3, 'sent') returning id", [
    s.companyId,
    theirs,
    FAR,
  ]);
  for (const u of [p, ctrl])
    await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id, status, sent_at) values ($1, $2, $3, $4, $5, 'sent', now())", [
      s.companyId,
      theirs,
      tOcc,
      emailOf(s, u),
      u,
    ]);
  const posted = await addComment(await actor(admin), s.companyId, theirs, { body: `@${p} @${ctrl} have a look`, parentId: null, mentionIds: [p, ctrl] }, { send: mail.send });
  assert.ok("id" in posted, JSON.stringify(posted));
  const mid = posted.id;
  assert.ok((await notes(s, ctrl)).some((n) => n.comment_id === mid), `control: a person with the defaults is told of the mention (${JSON.stringify(posted)}); ctrl has ${JSON.stringify(await notes(s, ctrl))}; mentions ${JSON.stringify(await q("select user_id = $2 as ctrl from comment_mentions where comment_id = $1", [mid, ctrl]))}`);
  assert.ok(
    (await notes(s, p)).some((n) => n.comment_id === mid),
    `mention: in Notifications; addComment returned ${JSON.stringify(posted)}; p has: ${JSON.stringify((await notes(s, p)).map((n) => n.kind))}`,
  );

  assert.equal(mail.to(emailOf(s, p)).length, 0, "and no email");
  await sleep(1500);
  assert.equal(await mailpit(emailOf(s, p)), 0, "no email from the decisions either");
});

test("N8: reminders, tasks and follow-ups are never on the page and never muted", async () => {
  for (const m of MUTABLE) {
    assert.ok(!["reminder", "reminders", "task", "tasks", "followup", "follow_up", "followups"].includes(m.event), `not listed: ${m.event}`);
    assert.doesNotMatch(m.label, /follow.?up|(reminder|task)s? (sent|for) (to )?(me|you)|^(a )?(reminder|task) (arrives|was sent)/i, `not listed: ${m.label}`);
  }
  const p = await s.user({ roles: [MEMBER_ROLE_ID] });
  const reminderKeys = ["reminder", "task", "followup", "follow_up"].flatMap((e) => [`${e}:email`, `${e}:slack`]);
  // Through the API: ignored.
  await setMutes(s.companyId, p, [...defaultOff(), ...reminderKeys]);
  const mutes = await getMutes(s.companyId, p);
  for (const k of reminderKeys) assert.ok(!mutes.has(k), `${k} not saved`);
  // Even a row written straight to the table doesn't stop a reminder.
  for (const k of reminderKeys) {
    const [event, channel] = k.split(":");
    await q("insert into notification_mutes (company_id, user_id, event, channel, enabled) values ($1, $2, $3, $4, false) on conflict do nothing", [
      s.companyId,
      p,
      event,
      channel,
    ]);
  }
  const rid = await reminder({ createdBy: admin, status: "sending", targets: [["user", p]] });
  const [{ id: occ }] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, $3, 'sending') returning id", [
    s.companyId,
    rid,
    FAR,
  ]);
  const [{ id: del }] = await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id) values ($1, $2, $3, $4, $5) returning id", [
    s.companyId,
    rid,
    occ,
    emailOf(s, p),
    p,
  ]);
  const mail = capture();
  assert.equal(await deliverOne(del, mail.send), "sent");
  assert.equal(mail.to(emailOf(s, p)).length, 1, "the reminder email still went out");
  await q("delete from notification_mutes where user_id = $1", [p]);
});

test("N9: a made-up event:channel is ignored; the rest saves", async () => {
  const p = await s.user({ roles: [MEMBER_ROLE_ID] });
  const real = `${ev("rejected")}:email`;
  await setMutes(s.companyId, p, ["made:up", `${ev("commented")}:fax`, "nonsense", ":", real, ...defaultOff()]);
  const mutes = await getMutes(s.companyId, p);
  assert.ok(mutes.has(real), "the real choice saved");
  for (const k of ["made:up", `${ev("commented")}:fax`, "nonsense", ":"]) assert.ok(!mutes.has(k), `${k} ignored`);
  const rows = await q("select event, channel from notification_mutes where user_id = $1", [p]);
  const known = new Set(allKeys());
  for (const r of rows) assert.ok(known.has(`${r.event}:${r.channel}`), `no row for ${r.event}:${r.channel}`);
});

test("N10: one person's choices never change anyone else's, in this company or another", async () => {
  const a = await s.user({ roles: [MEMBER_ROLE_ID] });
  const b = await s.user({ roles: [MEMBER_ROLE_ID] });
  const c = await other.user({ roles: [MEMBER_ROLE_ID] });
  await setMutes(other.companyId, c, [`${ev("mentioned")}:email`, ...defaultOff()]);
  const bBefore = [...(await getMutes(s.companyId, b))].sort();
  const cBefore = [...(await getMutes(other.companyId, c))].sort();

  await setMutes(s.companyId, a, allKeys());
  assert.deepEqual([...(await getMutes(s.companyId, b))].sort(), bBefore, "b unchanged");
  assert.deepEqual([...(await getMutes(other.companyId, c))].sort(), cBefore, "c unchanged");

  // Saving through this company for a person of another company doesn't touch theirs.
  await setMutes(s.companyId, c, []);
  assert.deepEqual([...(await getMutes(other.companyId, c))].sort(), cBefore, "c unchanged by another company's save");
  const cRows = await other.owner.query("select event, channel, enabled from notification_mutes where user_id = $1 and company_id = $2 order by 1, 2", [
    c,
    other.companyId,
  ]);
  assert.ok(cRows.rows.length > 0, "c's own rows still there");
  // b: still the defaults, with no row written for them.
  assert.deepEqual(bBefore, defaultOff().sort());
  assert.equal((await q("select 1 from notification_mutes where user_id = $1", [b])).length, 0);
});

test("N11: 'everyone finished my task' ticked: done, undone, redone sends one email, not two", async () => {
  const creator = await s.user({ roles: [MEMBER_ROLE_ID] });
  await tick(s, creator, `${ev("tasks done")}:email`);
  const [a1, a2] = [await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] })];
  const rid = await reminder({ createdBy: creator, status: "sent", isTask: true, targets: [["user", a1], ["user", a2]] });
  const [{ id: occ }] = await q(
    "insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, due_at) values ($1, $2, $3, 'sent', $4) returning id",
    [s.companyId, rid, FAR, new Date(FAR.getTime() + 3_600_000)],
  );
  const asg: Record<string, string> = {};
  for (const u of [a1, a2]) {
    await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id, status, sent_at) values ($1, $2, $3, $4, $5, 'sent', now())", [
      s.companyId,
      rid,
      occ,
      emailOf(s, u),
      u,
    ]);
    const [{ id }] = await q("insert into task_assignments (company_id, reminder_id, occurrence_id, user_id) values ($1, $2, $3, $4) returning id", [
      s.companyId,
      rid,
      occ,
      u,
    ]);
    asg[u] = id;
  }
  const doneAt = async (u: string) => (await q("select done_at from task_assignments where id = $1", [asg[u]]))[0].done_at;
  await setDone(a1, s.companyId, asg[a1], true);
  assert.ok(await doneAt(a1), "control: a1 done");
  await sleep(500);
  assert.equal(await mailpit(emailOf(s, creator)), 0, "not yet: one assignee left");
  await setDone(a2, s.companyId, asg[a2], true);
  assert.equal(await mailpitAtLeast(emailOf(s, creator), 1), 1, "one email when the last one is done");
  await setDone(a2, s.companyId, asg[a2], false);
  assert.equal(await doneAt(a2), null, "control: undone");
  await setDone(a2, s.companyId, asg[a2], true);
  await sleep(1500);
  assert.equal(await mailpit(emailOf(s, creator)), 1, "still one email after undo and redo");
  assert.equal((await notes(s, creator, "tasks_done")).length, 1, "and one in-app notification");
});

test("N12: 'my reminder was approved' ticked: emailed when approved by the button or by an approver's edit", async () => {
  // The button.
  const c1 = await s.user({ roles: [MEMBER_ROLE_ID] });
  await tick(s, c1, `${ev("approved")}:email`);
  const r1 = await pendingBy(c1);
  assert.equal(await decideReminder({ id: approver, access: await loadAccess(s.companyId, approver) }, s.companyId, r1, true), null);
  assert.equal(await mailpitAtLeast(emailOf(s, c1), 1), 1, "approved by the button: one email");

  // An approver's edit of the pending reminder approves it. Read as: the
  // approver edits it into something the creator may send (here: only to
  // themselves), so it goes from waiting to scheduled without the button.
  const c2 = await s.user({ roles: [MEMBER_ROLE_ID] });
  await tick(s, c2, `${ev("approved")}:email`);
  const r2 = await pendingBy(c2);
  const before = await mailpit(emailOf(s, c2));
  assert.equal(
    await updateReminder({ id: approver, access: await loadAccess(s.companyId, approver) }, s.companyId, r2, pendingInput([{ kind: "user", ref: c2 }])),
    null,
  );
  assert.equal((await q("select status from reminders where id = $1", [r2]))[0].status, "scheduled", "control: the edit approved it");
  assert.equal(await mailpitAtLeast(emailOf(s, c2), before + 1), before + 1, "approved by an approver's edit: one email");
});
