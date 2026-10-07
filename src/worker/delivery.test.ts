import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { claimFollowUps, deliverOne, dispatchDue, followUpOne, MAX_ATTEMPTS, sweep } from "./delivery";

const s = seeder();
let reminderId: string;
let creator: string;
let alice: string;
const mailpit = async (to: string) =>
  (await (await fetch(`http://localhost:8025/api/v1/search?query=to:${encodeURIComponent(to)}`)).json()).messages_count as number;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const failingSend = async () => {
  throw new Error("SMTP down");
};

before(async () => {
  await s.company();
  creator = await s.user();
  alice = await s.user();
  const [bob, gone] = [await s.user(), await s.user()];
  await q(`update "user" set deactivated_at = now() where id = $1`, [gone]);
  const [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  for (const u of [alice, bob, gone]) await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, u]);
  [{ id: reminderId }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status, time_zone, anchor_local)
     values ($1, $2, $3, 'Fire drill', 'At 3pm', 'HR', now() + interval '1 hour', 'scheduled', 'UTC', '2026-01-01T00:00') returning id`,
    [s.companyId, `R-${s.companyId.slice(0, 6).toUpperCase()}`, creator],
  );
  await q("insert into reminder_targets values ($1, $2, 'department', $3), ($1, $2, 'email', $4)", [
    reminderId,
    s.companyId,
    ops,
    `ext@${s.domain}`,
  ]);
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
});

test("dispatch: parallel runs make one delivery per recipient", async () => {
  const enqueued: string[] = [];
  const enqueue = async (ids: string[]) => void enqueued.push(...ids);
  // "Now" is two hours ahead, so the reminder (due in 1h) is due for us but not for a live worker.
  const inTwoHours = new Date(Date.now() + 2 * 3_600_000);
  const [a, b] = await Promise.all([
    dispatchDue(enqueue, s.companyId, inTwoHours),
    dispatchDue(enqueue, s.companyId, inTwoHours),
  ]);
  assert.equal(a + b, 1); // one run got it, the other skipped the locked row
  const rows = await q("select email, status from deliveries where reminder_id = $1 order by email", [reminderId]);
  assert.equal(rows.length, 3); // alice, bob, ext (not the deactivated one)
  assert.equal(enqueued.length, 3);
  assert.deepEqual((await q("select status from reminders where id = $1", [reminderId]))[0], { status: "sending" });
  assert.equal(await dispatchDue(enqueue, s.companyId, inTwoHours), 0); // nothing left due
  const occ = await q("select status from reminder_occurrences where reminder_id = $1", [reminderId]);
  assert.deepEqual(occ, [{ status: "sending" }]);
});

test("deliver: one email even when claimed twice; retries then fails", async () => {
  const rows = await q("select id, email from deliveries where reminder_id = $1 order by email", [reminderId]);
  const [first, second, third] = rows;

  const results = await Promise.all([deliverOne(first.id), deliverOne(first.id)]);
  assert.deepEqual(results.sort(), ["sent", "skipped"]);
  assert.equal(await mailpit(first.email), 1);

  await assert.rejects(deliverOne(second.id, failingSend), /SMTP down/);
  assert.deepEqual(
    (await q("select status, attempts, last_error from deliveries where id = $1", [second.id]))[0],
    { status: "queued", attempts: 1, last_error: "SMTP down" },
  );
  await q("update deliveries set attempts = $2 where id = $1", [second.id, MAX_ATTEMPTS - 1]);
  assert.equal(await deliverOne(second.id, failingSend), "failed");
  assert.equal(await deliverOne(second.id), "skipped"); // failed is final

  assert.deepEqual((await q("select status from reminders where id = $1", [reminderId]))[0], { status: "sending" });
  assert.equal(await deliverOne(third.id), "sent");
  // Nothing in flight any more: the reminder is done.
  assert.deepEqual((await q("select status from reminders where id = $1", [reminderId]))[0], { status: "sent" });
  assert.deepEqual(await q("select status from reminder_occurrences where reminder_id = $1", [reminderId]), [{ status: "sent" }]);
});

test("sweep: stuck sends fail (never resent), old queued rows come back for re-enqueue", async () => {
  const [{ id: occ }] = await q("select id from reminder_occurrences where reminder_id = $1", [reminderId]);
  const [{ id: stuck }] = await q(
    `insert into deliveries (company_id, reminder_id, occurrence_id, email, status, attempts, updated_at)
     values ($1, $2, $3, $4, 'sending', 1, now() - interval '11 minutes') returning id`,
    [s.companyId, reminderId, occ, `stuck@${s.domain}`],
  );
  const [{ id: orphan }] = await q(
    `insert into deliveries (company_id, reminder_id, occurrence_id, email, status, updated_at)
     values ($1, $2, $3, $4, 'queued', now() - interval '3 minutes') returning id`,
    [s.companyId, reminderId, occ, `orphan@${s.domain}`],
  );
  const orphans = await sweep();
  assert.ok(orphans.includes(orphan));
  const [row] = await q("select status, last_error from deliveries where id = $1", [stuck]);
  assert.equal(row.status, "failed");
  assert.match(row.last_error, /Not resent/);
  assert.equal(await mailpit(`stuck@${s.domain}`), 0);
});

// A daily series anchored at a fixed UTC time; "now" for dispatch is passed
// explicitly, far in the future, so a live worker never sees these as due.
const series = async (title: string, anchor: string, rule: object, sendAt: string) => {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, recurrence)
     values ($1, $2, $3, $4, 'HR', $5, 'scheduled', 'UTC', $6, $7) returning id`,
    [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, creator, title, sendAt, anchor, JSON.stringify(rule)],
  );
  await q("insert into reminder_targets values ($1, $2, 'user', $3)", [id, s.companyId, alice]);
  return id as string;
};
const daily = { freq: "daily", interval: 1, end: { type: "never" } };
const occurrencesOf = async (id: string) =>
  (await q("select occurs_at, status from reminder_occurrences where reminder_id = $1 order by occurs_at", [id])).map(
    (o) => `${o.occurs_at.toISOString().slice(0, 16)} ${o.status}`,
  );

test("recurring: one occurrence per run, then advance; catch-up sends only the latest", async () => {
  const id = await series("Daily standup", "2040-01-01T09:00", daily, "2040-01-01T09:00Z");
  const enqueued: string[] = [];
  const enqueue = async (ids: string[]) => void enqueued.push(...ids);

  await dispatchDue(enqueue, s.companyId, new Date("2040-01-01T09:00:30Z"));
  assert.deepEqual(await occurrencesOf(id), ["2040-01-01T09:00 sending"]);
  const [r1] = await q("select status, send_at from reminders where id = $1", [id]);
  assert.deepEqual([r1.status, r1.send_at.toISOString()], ["scheduled", "2040-01-02T09:00:00.000Z"]); // next, still scheduled
  assert.equal(enqueued.length, 1);

  // Worker "down" until the 5th at 10:00: the 2nd, 3rd and 4th are missed, the 5th is sent.
  await dispatchDue(enqueue, s.companyId, new Date("2040-01-05T10:00:00Z"));
  assert.deepEqual(await occurrencesOf(id), [
    "2040-01-01T09:00 sending",
    "2040-01-02T09:00 missed",
    "2040-01-03T09:00 missed",
    "2040-01-04T09:00 missed",
    "2040-01-05T09:00 sending",
  ]);
  assert.equal(enqueued.length, 2); // one delivery each for the 1st and the 5th, none for missed ones
  const [r2] = await q("select send_at from reminders where id = $1", [id]);
  assert.equal(r2.send_at.toISOString(), "2040-01-06T09:00:00.000Z");

  // Parallel runs on the same due series: still one occurrence for the 6th.
  await Promise.all([
    dispatchDue(enqueue, s.companyId, new Date("2040-01-06T09:00:10Z")),
    dispatchDue(enqueue, s.companyId, new Date("2040-01-06T09:00:10Z")),
  ]);
  assert.equal((await occurrencesOf(id)).filter((o) => o.startsWith("2040-01-06")).length, 1);
  assert.equal(enqueued.length, 3);
  // Stop the series so the next test's far-future dispatch doesn't catch it up.
  await q("update reminders set status = 'cancelled' where id = $1", [id]);
});

test("recurring: a skipped occurrence isn't sent; a counted series ends", async () => {
  const id = await series("Twice", "2041-03-01T08:00", { ...daily, end: { type: "count", count: 2 } }, "2041-03-01T08:00Z");
  await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, '2041-03-01T08:00Z', 'skipped')", [
    s.companyId,
    id,
  ]);
  const enqueued: string[] = [];
  await dispatchDue(async (ids) => void enqueued.push(...ids), s.companyId, new Date("2041-03-01T08:00:05Z"));
  assert.equal(enqueued.length, 0); // skipped
  await dispatchDue(async (ids) => void enqueued.push(...ids), s.companyId, new Date("2041-03-02T08:00:05Z"));
  assert.equal(enqueued.length, 1);
  assert.deepEqual(await occurrencesOf(id), ["2041-03-01T08:00 skipped", "2041-03-02T08:00 sending"]);
  // Second (last) occurrence dispatched: the reminder is finishing.
  assert.deepEqual((await q("select status from reminders where id = $1", [id]))[0], { status: "sending" });
  assert.equal(await deliverOne(enqueued[0], async () => ({}) as never), "sent");
  assert.deepEqual((await q("select status from reminders where id = $1", [id]))[0], { status: "sent" });
});

test("tasks: due_at per occurrence; daily follow-ups at the company's local time", async () => {
  await q("update companies set time_zone = 'Asia/Kolkata', follow_up_time = '09:00' where id = $1", [s.companyId]);
  const bob = await s.user();
  const carol = await s.user();
  await q(`update "user" set deactivated_at = now() where id = $1`, [carol]);
  // A task sent 2042-05-01 08:00 IST, due 2 hours later (10:00 IST).
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes)
     values ($1, 'R-TASK42', $2, 'Expense report', 'HR', '2042-05-01T08:00+05:30', 'scheduled', 'Asia/Kolkata', '2042-05-01T08:00', true, 120) returning id`,
    [s.companyId, creator],
  );
  for (const u of [alice, bob, carol]) await q("insert into reminder_targets values ($1, $2, 'user', $3)", [id, s.companyId, u]);
  const ids: string[] = [];
  await dispatchDue(async (x) => void ids.push(...x), s.companyId, new Date("2042-05-01T02:31:00Z"));
  const [occ] = await q("select due_at from reminder_occurrences where reminder_id = $1", [id]);
  assert.equal(occ.due_at.toISOString(), "2042-05-01T04:30:00.000Z"); // 10:00 IST
  for (const d of ids) await deliverOne(d, async () => ({}) as never);
  const byUser = async (u: string) => (await q("select id, followups from deliveries where reminder_id = $1 and user_id = $2", [id, u]))[0];

  const claim = (ist: string) => claimFollowUps(new Date(`${ist}+05:30`), s.companyId);
  assert.deepEqual(await claim("2042-05-01T12:00"), []); // overdue, but today's 09:00 slot was before the due time
  assert.deepEqual(await claim("2042-05-02T08:59"), []); // before tomorrow's slot
  const day2 = await claim("2042-05-02T09:00");
  assert.deepEqual(day2.sort(), [(await byUser(alice)).id, (await byUser(bob)).id].sort()); // carol is deactivated
  assert.deepEqual(await claim("2042-05-02T15:00"), []); // once a day

  await q("update deliveries set done_at = now() where id = $1", [(await byUser(bob)).id]);
  assert.deepEqual(await claim("2042-05-03T09:01"), [(await byUser(alice)).id]);
  assert.equal((await byUser(alice)).followups, 2);
  assert.equal((await byUser(bob)).followups, 1);

  const sent: string[] = [];
  const capture = async (m: { subject: string }) => void sent.push(m.subject);
  assert.equal(await followUpOne((await byUser(alice)).id, capture as never), "sent");
  assert.equal(await followUpOne((await byUser(bob)).id, capture as never), "skipped"); // done since
  assert.deepEqual(sent, ["Overdue: Expense report"]);
  await q("update reminders set status = 'cancelled' where id = $1", [id]);
});
