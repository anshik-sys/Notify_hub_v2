import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { seeder } from "./test-helpers";
import { calendarMonth, calendarRange, calendarView, dashboardStats, filterUrl, parseFilters, searchReminders, shownOn } from "./views";

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

test("show filter: shared with me and sent to me are listed; dashboard ignores them", async () => {
  const at = new Date("2030-01-02T00:00Z");
  const before = await dashboardStats(s.companyId, await viewer(alice), "UTC", at);
  const shared = await mk(bob, "Bob shares with Ops");
  await q("insert into reminder_shares (reminder_id, company_id, kind, ref) values ($1, $2, 'department', $3)", [shared, s.companyId, ops]);
  const toAlice = await mk(bob, "Bob sends to alice", { status: "sent", sendAt: "2025-02-01T09:00Z" });
  const [{ id: occ }] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now(), 'sent') returning id", [s.companyId, toAlice]);
  await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id, status) values ($1, $2, $3, $4, $4, 'sent')", [s.companyId, toAlice, occ, alice]);

  const all = await titles(alice, {});
  assert.ok(all.includes("Bob shares with Ops") && all.includes("Bob sends to alice"));
  assert.deepEqual(await titles(alice, { show: "shared" }), ["Bob shares with Ops"]);
  assert.deepEqual(await titles(alice, { show: "received" }), ["Bob sends to alice"]);
  assert.ok(!(await titles(alice, { show: "mine" })).includes("Bob shares with Ops"));
  assert.ok(!(await titles(alice, { show: "oversee" })).includes("Bob shares with Ops"));
  assert.ok(!(await titles(mgr, { q: "Bob sends" })).length); // not shared with the manager, not sent to them

  assert.deepEqual(await dashboardStats(s.companyId, await viewer(alice), "UTC", at), before); // shared/received don't count

  const cal = (await calendarMonth(s.companyId, await viewer(alice), "UTC", "2030-01"))!;
  assert.ok([...cal.days.values()].flat().some((e) => e.title === "Bob shares with Ops"));
  await q("update reminders set status = 'cancelled' where id = any($1)", [[shared, toAlice]]);
});

test("calendarView: ranges, steps and fallbacks per view", () => {
  const t = "2026-10-20"; // a Tuesday
  const m = calendarView({}, t);
  assert.deepEqual([m.view, m.from, m.to, m.prev, m.next, m.title], ["month", "2026-10-01", "2026-11-01", "2026-09-01", "2026-11-01", "October 2026"]);
  const w = calendarView({ view: "week", date: "2026-10-25" }, t); // a Sunday: its week starts Monday the 19th
  assert.deepEqual([w.from, w.to, w.prev, w.next], ["2026-10-19", "2026-10-26", "2026-10-12", "2026-10-26"]);
  const d = calendarView({ view: "day", date: "2026-12-31" }, t);
  assert.deepEqual([d.from, d.to, d.next, d.title], ["2026-12-31", "2027-01-01", "2027-01-01", "Thursday, 31 December 2026"]);
  const n = calendarView({ view: "days", date: t, n: "3" }, t);
  assert.deepEqual([n.from, n.to, n.prev, n.next], ["2026-10-20", "2026-10-23", "2026-10-17", "2026-10-23"]);
  assert.equal(calendarView({ view: "days", n: "40" }, t).n, 7);
  assert.equal(calendarView({ view: "days", n: "x" }, t).n, 4);
  assert.equal(calendarView({ view: "year", date: "2026-02-30" }, t).view, "month");
  assert.equal(calendarView({ date: "2026-02-30" }, t).date, t); // not a real day
  assert.equal(calendarView({ view: "month", date: "2027-01-15" }, t).prev, "2026-12-01");
});

test("calendarRange: waiting and sent entries, layers, a colleague's overlay", async () => {
  const sales = (await q("insert into departments (company_id, name) values ($1, 'Sales') returning id", [s.companyId]))[0].id;
  const task = await mk(alice, "Task for ops", { task: true, sendAt: "2031-05-06T09:00Z" });
  await q("insert into reminder_targets values ($1, $2, 'department', $3, null)", [task, s.companyId, ops]);
  // Bob's upcoming task to Ops: alice can't open it until it's sent to her (PRD 5.4, as built).
  const bobsTask = await mk(bob, "Bob's task for ops", { task: true, sendAt: "2031-05-06T10:00Z" });
  await q("insert into reminder_targets values ($1, $2, 'department', $3, null)", [bobsTask, s.companyId, ops]);
  const everyone = await mk(alice, "All hands", { sendAt: "2031-05-07T09:00Z" });
  await q("insert into reminder_targets values ($1, $2, 'company', null, null)", [everyone, s.companyId]);
  await mk(alice, "Waiting one", { sendAt: "2031-05-08T09:00Z", status: "pending_approval" });
  const toSales = await mk(bob, "Sales only", { sendAt: "2031-05-09T09:00Z" });
  await q("insert into reminder_targets values ($1, $2, 'department', $3, null)", [toSales, s.companyId, sales]);
  await mk(alice, "Paused one", { sendAt: "2031-05-10T09:00Z", status: "paused" });
  const went = await mk(bob, "Went out", { sendAt: "2031-05-04T09:00Z", status: "sent" });
  await q("insert into reminder_targets values ($1, $2, 'user', $3, null)", [went, s.companyId, alice]);
  const [{ id: occ }] = await q(
    `insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, snapshot) values ($1, $2, '2031-05-04T09:00Z', 'sent', '{"title":"Went out (as sent)","description":"","links":[],"senderName":"S"}') returning id`,
    [s.companyId, went],
  );
  await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id, status) values ($1, $2, $3, $4, $4, 'sent')", [s.companyId, went, occ, alice]);

  const range = { from: "2031-05-01", to: "2031-06-01" };
  const all = [...(await calendarRange(s.companyId, await viewer(alice), "UTC", range))!.days.values()].flat();
  const by = (title: string) => all.find((e) => e.title === title);
  assert.deepEqual(by("Task for ops")?.layers, ["mine", "assigned", "departments"]);
  assert.deepEqual(by("All hands")?.layers, ["mine", "company"]);
  assert.equal(by("Bob's task for ops"), undefined);
  assert.equal(by("Waiting one")?.state, "pending");
  assert.deepEqual(by("Waiting one")?.layers, ["mine"]);
  assert.equal(by("Went out (as sent)")?.state, "sent");
  assert.deepEqual(by("Went out (as sent)")?.layers, ["other"]); // sent to her directly: no layer of its own
  assert.equal(by("Sales only"), undefined); // alice can't open it
  assert.equal(by("Paused one"), undefined);
  assert.equal(by("Went out"), undefined); // shown as it was sent, once

  // Layers: hidden only when all of an entry's layers are off.
  assert.equal(shownOn(by("Task for ops")!, new Set(["departments"])), true);
  assert.equal(shownOn(by("Task for ops")!, new Set(["company", "other"])), false);

  // The admin overlays bob: his own and what's addressed to him are flagged; others aren't.
  const adm = [...(await calendarRange(s.companyId, await viewer(admin), "UTC", { ...range, person: bob }))!.days.values()].flat();
  assert.equal(adm.find((e) => e.title === "Sales only")?.theirs, true); // he created it
  assert.equal(adm.find((e) => e.title === "All hands")?.theirs, true); // addressed to the whole company
  assert.equal(adm.find((e) => e.title === "Waiting one")?.theirs, false);
  // Alice overlaying bob still sees only what she could open.
  const al = [...(await calendarRange(s.companyId, await viewer(alice), "UTC", { ...range, person: bob }))!.days.values()].flat();
  assert.ok(!al.some((e) => e.title === "Sales only"));
  assert.equal(await calendarRange(s.companyId, await viewer(alice), "UTC", { from: "2031-06-01", to: "2031-05-01" }), null);
  await q("update reminders set status = 'cancelled' where id = any($1)", [[task, bobsTask, everyone, toSales]]);
});

test("search finds a reminder by its creator's name", async () => {
  assert.ok((await titles(admin, { q: "Bob Build" })).includes("Bob's own"));
});
