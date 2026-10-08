import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { deliveryVolume, duration, overdueTasks, parseReportFilters, taskCompletion, toCsv } from "./reports";
import { seeder } from "./test-helpers";

// Fixed dates in 2030 (and 2029 for "overdue"), so a live worker never touches them.
const s = seeder();
const other = seeder();
let alice: string, bob: string, carol: string, ops: string, sales: string, night: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
let n = 0;
const reminder = async (status = "sent", isTask = false) =>
  (
    await q(
      `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes)
       values ($1, $2, $3, $4, 'S', '2030-01-01T09:00Z', $5, 'UTC', '2030-01-01T09:00', $6, $7) returning id`,
      [s.companyId, `R-P${String(++n).padStart(5, "0")}`, alice, `Task ${n}`, status, isTask, isTask ? 60 : null],
    )
  )[0].id as string;
const occurrence = async (reminderId: string, at: string, due: string | null) =>
  (await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, due_at) values ($1, $2, $3, 'sent', $4) returning id", [s.companyId, reminderId, at, due]))[0].id as string;
const delivery = (reminderId: string, occ: string, channel: string, status: string, at: string) =>
  q(
    `insert into deliveries (company_id, reminder_id, occurrence_id, address, channel, status, sent_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, case when $6 = 'sent' then $7::timestamptz end, $7)`,
    [s.companyId, reminderId, occ, `${Math.random()}@x.test`, channel, status, at],
  );
const assign = (reminderId: string, occ: string, userId: string, doneAt: string | null) =>
  q("insert into task_assignments (company_id, reminder_id, occurrence_id, user_id, done_at) values ($1, $2, $3, $4, $5)", [s.companyId, reminderId, occ, userId, doneAt]);
const F = (p: Record<string, string>, tz = "UTC") => parseReportFilters(p, tz, new Date("2030-02-01T00:00Z"));

before(async () => {
  await s.company();
  await other.company();
  [alice, bob, carol] = [await s.user(), await s.user(), await s.user()];
  for (const [u, name] of [[alice, "Alice"], [bob, "Bob"], [carol, "Carol"]]) await q(`update "user" set name = $2 where id = $1`, [u, name]);
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  [{ id: sales }] = await q("insert into departments (company_id, name) values ($1, 'Sales') returning id", [s.companyId]);
  await q("insert into department_members values ($1, $2, $3, false), ($1, $2, $4, false), ($1, $5, $4, false)", [s.companyId, ops, alice, bob, sales]);
  [{ id: night }] = await q("insert into groups (company_id, name) values ($1, 'Night') returning id", [s.companyId]);
  await q("insert into group_members values ($1, $2, $3)", [night, s.companyId, carol]);
});
after(async () => {
  await s.cleanup();
  await other.cleanup();
  await db.$client.end();
});

test("filters: defaults, junk, hourly only for a week", () => {
  assert.deepEqual(F({}), { report: "delivery", from: "2030-01-03", to: "2030-02-01", bucket: "day", by: "department" });
  assert.deepEqual(F({ report: "x", bucket: "year", by: "planet", from: "nope" }).bucket, "day");
  assert.equal(F({ bucket: "hour", from: "2030-01-01", to: "2030-01-31" }).bucket, "day");
  assert.equal(F({ bucket: "hour", from: "2030-01-01", to: "2030-01-07" }).bucket, "hour");
  assert.deepEqual([F({ from: "2030-01-09", to: "2030-01-02" }).from, F({ from: "2030-01-09", to: "2030-01-02" }).to], ["2030-01-02", "2030-01-09"]);
});

test("delivery volume by day and month, per channel, with success rate", async () => {
  const r = await reminder();
  const occ = await occurrence(r, "2030-01-10T09:00Z", null);
  await delivery(r, occ, "email", "sent", "2030-01-10T09:01Z");
  await delivery(r, occ, "email", "sent", "2030-01-10T10:00Z");
  await delivery(r, occ, "email", "failed", "2030-01-11T09:00Z");
  await delivery(r, occ, "slack", "sent", "2030-01-11T23:30Z"); // the 12th in Dubai
  const d = await deliveryVolume(s.companyId, "UTC", F({ from: "2030-01-01", to: "2030-01-31" }));
  assert.deepEqual(d.rows.map((x) => [x.bucket, x.email.sent, x.email.failed, x.slack.sent]), [
    ["2030-01-10", 2, 0, 0],
    ["2030-01-11", 0, 1, 1],
  ]);
  assert.equal(Math.round(d.totals.email.rate! * 100), 67);
  assert.equal(d.totals.slack.rate, 1);
  const dubai = await deliveryVolume(s.companyId, "Asia/Dubai", F({ from: "2030-01-01", to: "2030-01-31" }, "Asia/Dubai"));
  assert.deepEqual(dubai.rows.map((x) => x.bucket), ["2030-01-10", "2030-01-11", "2030-01-12"]);
  const month = await deliveryVolume(s.companyId, "UTC", F({ from: "2030-01-01", to: "2030-01-31", bucket: "month" }));
  assert.deepEqual(month.rows.map((x) => [x.bucket, x.email.sent + x.email.failed + x.slack.sent]), [["2030-01", 4]]);
  assert.equal((await deliveryVolume(other.companyId, "UTC", F({ from: "2030-01-01", to: "2030-01-31" }))).rows.length, 0);
});

test("task completion per department, group and person", async () => {
  const t = await reminder("sent", true);
  const occ = await occurrence(t, "2030-01-15T09:00Z", "2030-01-15T10:00Z");
  await assign(t, occ, alice, "2030-01-15T09:30Z"); // on time, 30 m
  await assign(t, occ, bob, "2030-01-15T11:30Z"); // late, 150 m
  await assign(t, occ, carol, null); // open
  const byDept = await taskCompletion(s.companyId, "UTC", F({ from: "2030-01-01", to: "2030-01-31", by: "department" }));
  assert.deepEqual(byDept.map((r) => [r.name, r.assigned, r.done, r.on_time, r.avg_minutes]), [
    ["No department", 1, 0, 0, null], // carol
    ["Ops", 2, 2, 1, 90],
    ["Sales", 1, 1, 0, 150], // bob is in Ops and Sales: counted in both
  ]);
  const byGroup = await taskCompletion(s.companyId, "UTC", F({ from: "2030-01-01", to: "2030-01-31", by: "group" }));
  assert.deepEqual(byGroup.map((r) => [r.name, r.assigned, r.rate]), [["Night", 1, 0], ["No group", 2, 1]]);
  const byPerson = await taskCompletion(s.companyId, "UTC", F({ from: "2030-01-01", to: "2030-01-31", by: "person" }));
  assert.deepEqual(byPerson.map((r) => r.name), ["Alice", "Bob", "Carol"]);
  assert.equal((await taskCompletion(s.companyId, "UTC", F({ from: "2030-02-01", to: "2030-02-28" }))).length, 0); // out of range
});

test("overdue: open and past due only, not cancelled", async () => {
  const t = await reminder("sent", true);
  const occ = await occurrence(t, "2029-12-01T09:00Z", "2029-12-01T10:00Z");
  await assign(t, occ, alice, null);
  await assign(t, occ, bob, "2029-12-01T09:30Z"); // done
  const gone = await reminder("cancelled", true);
  await assign(gone, await occurrence(gone, "2029-12-01T09:00Z", "2029-12-01T10:00Z"), bob, null);
  const now = new Date("2029-12-04T10:00Z");
  const o = await overdueTasks(s.companyId, F({ by: "person" }), now);
  assert.deepEqual(o.summary.map((r) => [r.name, r.overdue]), [["Alice", 1]]);
  assert.deepEqual(o.detail.map((d) => [d.person, d.daysOverdue]), [["Alice", 3]]);
  // Carol's open task from the completion test is due 2030-01-15: not overdue yet at "now".
});

test("csv and durations", () => {
  assert.equal(toCsv(["a", "b"], [["=1+1", "x,y"]]), "a,b\r\n'=1+1,\"x,y\"\r\n");
  assert.deepEqual([duration(null), duration(45), duration(150), duration(1500)], ["—", "45 m", "2 h 30 m", "1 d 1 h"]);
});
