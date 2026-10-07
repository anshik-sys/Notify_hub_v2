import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { seeder } from "./test-helpers";
import { calendarMonth, dashboardStats, filterUrl, parseFilters, searchReminders } from "./views";

const s = seeder();
let admin: string, mgr: string, alice: string, bob: string, ops: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const viewer = async (id: string) => ({ id, access: await loadAccess(s.companyId, id) });
let n = 0;
// Far-future send times, so a live worker never touches these.
const mk = async (by: string, title: string, o: Record<string, unknown> = {}) =>
  (
    await q(
      `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status, time_zone, anchor_local, recurrence, is_task, due_after_minutes, channels, tags)
       values ($1, $2, $3, $4, $5, 'S', $6, $7, 'UTC', $8, $9, $10, $11, $12, $13) returning id`,
      [
        s.companyId,
        `R-V${String(++n).padStart(5, "0")}`,
        by,
        title,
        o.description ?? "",
        o.sendAt ?? "2030-01-10T09:00Z",
        o.status ?? "scheduled",
        o.anchor ?? "2030-01-10T09:00",
        o.recurrence ? JSON.stringify(o.recurrence) : null,
        Boolean(o.task),
        o.task ? 60 : null,
        o.channels ?? ["email"],
        o.tags ?? [],
      ],
    )
  )[0].id as string;
const titles = async (by: string, p: Record<string, string>) =>
  (await searchReminders(s.companyId, await viewer(by), "UTC", parseFilters(p))).rows.map((r) => r.title).sort();

before(async () => {
  await s.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [mgr, alice, bob] = [await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] })];
  await q(`update "user" set name = 'Bob Builder' where id = $1`, [bob]);
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Operations') returning id", [s.companyId]);
  await q("insert into department_members values ($1, $2, $3, true), ($1, $2, $4, false)", [s.companyId, ops, mgr, alice]);

  const a1 = await mk(alice, "Payroll run", { tags: ["payroll", "q3"], description: "100% on time" });
  await q("insert into reminder_targets values ($1, $2, 'user', $3, null)", [a1, s.companyId, bob]);
  const a2 = await mk(alice, "Fire drill", { channels: ["slack"], recurrence: { freq: "weekly", interval: 1, end: { type: "never" } } });
  await q("insert into reminder_targets values ($1, $2, 'department', $3, null)", [a2, s.companyId, ops]);
  await mk(alice, "Timesheet", { task: true, sendAt: "2030-02-01T09:00Z", status: "pending_approval" });
  await mk(bob, "Bob's own");
});
after(async () => {
  await s.cleanup();
  await db.$client.end();
});

test("visibility: own; a manager sees their department's; admins all; others none", async () => {
  assert.deepEqual(await titles(alice, {}), ["Fire drill", "Payroll run", "Timesheet"]);
  assert.deepEqual(await titles(mgr, {}), ["Fire drill", "Payroll run", "Timesheet"]);
  assert.deepEqual(await titles(bob, {}), ["Bob's own"]);
  assert.equal((await titles(admin, {})).length, 4);
});

test("search and filters", async () => {
  assert.deepEqual(await titles(alice, { q: "payroll" }), ["Payroll run"]); // title + tag
  assert.deepEqual(await titles(alice, { q: "Q3" }), ["Payroll run"]); // tag, any case
  assert.deepEqual(await titles(alice, { q: "R-V00002" }), ["Fire drill"]); // short id
  assert.deepEqual(await titles(alice, { q: "bob build" }), ["Payroll run"]); // recipient name
  assert.deepEqual(await titles(alice, { q: "operations" }), ["Fire drill"]); // department recipient
  assert.deepEqual(await titles(alice, { q: "100%" }), ["Payroll run"]); // % is literal
  assert.deepEqual(await titles(alice, { q: "1%0" }), []);
  assert.deepEqual(await titles(alice, { status: "pending_approval" }), ["Timesheet"]);
  assert.deepEqual(await titles(alice, { channel: "slack" }), ["Fire drill"]);
  assert.deepEqual(await titles(alice, { repeat: "weekly" }), ["Fire drill"]);
  assert.deepEqual(await titles(alice, { repeat: "none" }), ["Payroll run", "Timesheet"]);
  assert.deepEqual(await titles(alice, { type: "task" }), ["Timesheet"]);
  assert.deepEqual(await titles(alice, { tag: "Payroll" }), ["Payroll run"]);
  assert.deepEqual(await titles(alice, { from: "2030-01-15", to: "2030-02-01" }), ["Timesheet"]);
  assert.deepEqual(await titles(alice, { to: "2030-01-10" }), ["Fire drill", "Payroll run"]); // "to" is inclusive
  assert.deepEqual(await titles(mgr, { creator: alice, q: "drill" }), ["Fire drill"]);

  const sorted = await searchReminders(s.companyId, await viewer(alice), "UTC", parseFilters({ sort: "title_asc" }));
  assert.deepEqual(sorted.rows.map((r) => r.title), ["Fire drill", "Payroll run", "Timesheet"]);
  assert.equal(sorted.total, 3);
  const page2 = await searchReminders(s.companyId, await viewer(alice), "UTC", parseFilters({ page: "2" }));
  assert.deepEqual([page2.rows.length, page2.total], [0, 0]); // past the end: empty
});

test("parseFilters ignores junk; filterUrl round-trips", () => {
  const f = parseFilters({ status: "nope", channel: "fax", sort: "drop table", page: "-3", from: "2030-13", q: ["  hi  ", "x"], failed: "1" });
  assert.deepEqual([f.status, f.channel, f.sort, f.page, f.from, f.q, f.failed], [undefined, undefined, "send_desc", 1, undefined, "hi", true]);
  const url = filterUrl({ ...f, tag: "q3", page: 2 });
  assert.equal(url, "/reminders?q=hi&tag=q3&failed=1&page=2");
  assert.deepEqual(parseFilters(Object.fromEntries(new URLSearchParams(url.split("?")[1]))), { ...f, tag: "q3", page: 2 });
});

test("dashboard stats count what the viewer can see", async () => {
  const sent = await mk(alice, "Old news", { status: "sent", sendAt: "2025-01-01T09:00Z" });
  const [{ id: occ }] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now(), 'sent') returning id", [
    s.companyId,
    sent,
  ]);
  await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, status) values ($1, $2, $3, 'x@y.test', 'failed')", [s.companyId, sent, occ]);
  const now = new Date("2030-01-02T00:00Z"); // 7 days ahead = the 9th: nothing due yet
  assert.deepEqual(await dashboardStats(s.companyId, await viewer(alice), "UTC", now), { pending: 1, active: 2, dueSoon: 0, completed: 1, failed: 1 });
  assert.equal((await dashboardStats(s.companyId, await viewer(alice), "UTC", new Date("2030-01-04T00:00Z"))).dueSoon, 2); // 7 days ahead reaches the 10th
  assert.deepEqual(await dashboardStats(s.companyId, await viewer(bob), "UTC", now), { pending: 0, active: 1, dueSoon: 0, completed: 0, failed: 0 });
});

test("calendar: series expanded, skipped left out, local day, visibility", async () => {
  const daily = await mk(alice, "Standup", { sendAt: "2030-03-10T09:00Z", anchor: "2030-03-10T13:00", recurrence: { freq: "daily", interval: 1, end: { type: "never" } } });
  await q("update reminders set time_zone = 'Asia/Dubai' where id = $1", [daily]); // 13:00 Dubai = 09:00 UTC
  await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, '2030-03-15T09:00Z', 'skipped')", [s.companyId, daily]);
  await mk(alice, "Late one", { sendAt: "2030-03-20T23:30Z" });
  await mk(bob, "Not for alice", { sendAt: "2030-03-12T09:00Z" });

  const cal = (await calendarMonth(s.companyId, await viewer(alice), "Asia/Dubai", "2030-03"))!;
  const days = [...cal.days.entries()].filter(([, es]) => es.some((e) => e.title === "Standup")).map(([d]) => d);
  assert.equal(days.length, 21); // 10th–31st, minus the skipped 15th
  assert.ok(!days.includes("2030-03-15"));
  // 23:30 UTC is the 21st in Dubai (a Thursday, so the weekly drill is there too).
  assert.deepEqual(cal.days.get("2030-03-21")!.map((e) => e.title).sort(), ["Fire drill", "Late one", "Standup"]);
  assert.ok(!cal.days.get("2030-03-20")?.some((e) => e.title === "Late one"));
  assert.ok(![...cal.days.values()].flat().some((e) => e.title === "Not for alice"));
  assert.equal(await calendarMonth(s.companyId, await viewer(alice), "UTC", "2030-3"), null);
});
