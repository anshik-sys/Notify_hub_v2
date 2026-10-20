// Behaviour tests for docs/expected-behaviour.md section 10 (calendar: views
// and working on entries), written from the spec, not the code. A failure
// means the code or the spec is wrong.
//
// Companies: `s` for everything, `big` (its own) for the 500 limit (C12).
// Scheduled dates are 2031+ so a live worker never sends them. "Sent" entries
// are seeded as occurrence + delivery rows; ones that must be in the past are
// dated 2026-09 with their status already 'sent' (and task due dates in 2031),
// so the worker has nothing to do with them either.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { checkFile } from "./attachments";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import {
  cancelReminder,
  createReminder,
  decideReminder,
  deleteEntry,
  duplicateReminder,
  moveEntry,
  quickCreate,
  type RawReminder,
  type ReminderInput,
  setMyColor,
  validateInput,
} from "./reminders";
import { seeder } from "./test-helpers";
import { CALENDAR_LIMIT, type CalendarEntry, calendarRange, calendarView, DEFAULT_COLOR, parseFilters, searchReminders, shownOn } from "./views";

const s = seeder();
const big = seeder();
const TZ = "UTC";
let admin: string, alice: string, bob: string, carol: string, dave: string;
let editor: string, blindEditor: string, moverOnly: string, viewOnly: string;
let ops: string, sales: string;

const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const actor = async (id: string) => ({ id, name: id, email: `${id}@${s.domain}`, access: await loadAccess(s.companyId, id) });
const at = (local: string) => new Date(`${local}:00Z`); // "2031-03-03T09:00" (UTC)
const iso = (local: string) => at(local).toISOString();

const NO_REPEAT = { repeat: "none", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" };
const raw = (over: Partial<RawReminder> = {}): RawReminder => ({
  title: "Entry",
  description: "Some text",
  senderName: "",
  linkLabels: [],
  linkUrls: [],
  company: false,
  departmentIds: [],
  groupIds: [],
  userIds: [],
  emails: "",
  when: "later",
  sendAtLocal: "2031-03-03T09:00",
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
  ...over,
});
type Rule = NonNullable<ReminderInput["recurrence"]>;
const WEEKLY_MON: Rule = { freq: "weekly", interval: 1, weekdays: [0], end: { type: "never" } };
const input = (over: Partial<RawReminder> = {}, extra: Partial<ReminderInput> = {}, tz = TZ): ReminderInput => {
  const r = validateInput(raw(over), tz, "A");
  assert.ok("input" in r && r.input, `valid input: ${JSON.stringify(r)}`);
  return { ...r.input, ...extra };
};
type Files = Parameters<typeof createReminder>[3];
const file = (name: string, text: string) => {
  const r = checkFile(name, new TextEncoder().encode(text));
  assert.ok("file" in r);
  return r.file;
};
const make = async (by: string, over: Partial<RawReminder> = {}, extra: Partial<ReminderInput> = {}, files: Files = []) => {
  const r = await createReminder(await actor(by), s.companyId, input(over, extra), files);
  assert.ok("id" in r, JSON.stringify(r));
  return r.id;
};
const series = (by: string, first: string, rule: Rule, over: Partial<RawReminder> = {}, extra: Partial<ReminderInput> = {}, files: Files = []) =>
  make(by, { sendAtLocal: first, ...over }, { recurrence: rule, anchorLocal: first, ...extra }, files);

// Turns a one-time reminder into one sent in the past at `local`, delivered to `to`.
const sentPast = async (id: string, local: string, to: string[], task = false) => {
  await q("update reminders set send_at = $2, anchor_local = $3, status = 'sent' where id = $1", [id, iso(local), local]);
  return addSent(id, local, to, task);
};
// Records an occurrence of `id` at `local` as sent to `to` (internal users).
const addSent = async (id: string, local: string, to: string[], task = false) => {
  const [{ id: occ }] = await q(
    "insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, due_at) values ($1, $2, $3, 'sent', $4) returning id",
    [s.companyId, id, iso(local), task ? "2031-12-31T00:00:00Z" : null],
  );
  for (const u of to) {
    await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id, status, sent_at) values ($1, $2, $3, $4, $5, 'sent', $6)", [
      s.companyId,
      id,
      occ,
      `${u}@${s.domain}`,
      u,
      iso(local),
    ]);
    if (task) await q("insert into task_assignments (company_id, reminder_id, occurrence_id, user_id) values ($1, $2, $3, $4)", [s.companyId, id, occ, u]);
  }
  return occ as string;
};

const range = async (who: string, from: string, to: string, opts: { tz?: string; person?: string } = {}) => {
  const r = await calendarRange(s.companyId, await actor(who), opts.tz ?? TZ, { from, to, person: opts.person });
  assert.ok(r, "a valid range");
  return r;
};
type Range = NonNullable<Awaited<ReturnType<typeof calendarRange>>>;
const flat = (r: Range) => [...r.days.entries()].flatMap(([day, es]) => es.map((e) => ({ day, e })));
const of = (r: Range, id: string) => flat(r).filter((x) => x.e.reminderId === id);
// [local day, ISO time, state] for one reminder's entries.
const shape = (r: Range, id: string) => of(r, id).map(({ day, e }) => [day, e.at.toISOString(), e.state]);
const one = (r: Range, id: string): CalendarEntry => {
  const es = of(r, id);
  assert.equal(es.length, 1, `exactly one entry for ${id}, got ${es.length}`);
  return es[0].e;
};
const reminderCount = async () => (await q("select count(*)::int as n from reminders where company_id = $1", [s.companyId]))[0].n as number;
const row = async (id: string) => (await q("select * from reminders where id = $1", [id]))[0];
const targets = async (id: string) =>
  (await q("select kind, ref from reminder_targets where reminder_id = $1 order by kind, ref", [id])).map((t) => `${t.kind}:${t.ref}`);
const shares = async (id: string) =>
  (await q("select kind, ref from reminder_shares where reminder_id = $1 order by kind, ref", [id])).map((t) => `${t.kind}:${t.ref}`);
const fileNames = async (id: string) => (await q("select file_name from attachments where reminder_id = $1 order by file_name", [id])).map((f) => f.file_name);
const dateOf = (x: unknown) => {
  const m = /\d{4}-\d{2}-\d{2}/.exec(typeof x === "string" ? x : JSON.stringify(x));
  assert.ok(m, `a date in ${JSON.stringify(x)}`);
  return m[0];
};

before(async () => {
  await s.company();
  await big.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  alice = await s.user({ roles: [MEMBER_ROLE_ID] });
  bob = await s.user({ roles: [MEMBER_ROLE_ID] });
  carol = await s.user({ roles: [MEMBER_ROLE_ID] });
  dave = await s.user({ roles: [MEMBER_ROLE_ID] });
  const role = async (name: string, perms: string) =>
    (await q("insert into roles (company_id, name, permissions) values ($1, $2, $3) returning id", [s.companyId, name, perms]))[0].id as string;
  const editors = await role("Editors", "{reminders.edit,reminders.view_all}");
  const blind = await role("Blind editors", "{reminders.edit}");
  const viewers = await role("Viewers", "{reminders.view_all}");
  editor = await s.user({ roles: [MEMBER_ROLE_ID, editors] });
  blindEditor = await s.user({ roles: [MEMBER_ROLE_ID, blind] });
  moverOnly = await s.user({ roles: [editors] }); // edit + view all, cannot create
  viewOnly = await s.user({ roles: [viewers] }); // view all, cannot create
  const dept = async (name: string, members: string[]) => {
    const [{ id }] = await q("insert into departments (company_id, name) values ($1, $2) returning id", [s.companyId, name]);
    for (const u of members) await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, id, u]);
    return id as string;
  };
  ops = await dept("Ops", [alice, bob]);
  sales = await dept("Sales", [carol]);
});
after(async () => {
  await big.cleanup();
  await s.cleanup();
  await db.$client.end();
});

// --- Views and navigation (14.1) --------------------------------------------------------

test.skip("C1: Calendar opens on this month; view and date live in the URL (browser: page routing, reload, back and deep links)");
test("C1 (lib): no params = month view of the current month", () => {
  const v = calendarView({}, "2026-10-20");
  assert.equal(v.view, "month");
  assert.ok(v.from <= "2026-10-01", `from ${v.from} covers 1 Oct`);
  assert.ok(v.to >= "2026-11-01", `to ${v.to} covers 31 Oct`);
  assert.match(v.title, /October/);
  assert.match(v.title, /2026/);
  const w = calendarView({ view: "week", date: "2026-10-20" }, "2026-10-20");
  assert.equal(w.view, "week");
  assert.equal(w.date, "2026-10-20", "the URL's date is kept");
});

test.skip("C2: hour rows, 30-minute blocks, side-by-side blocks, now line (browser: layout)");
test("C2 (lib): week starts Monday; day is one day; 'days' is n days, n limited to 2–7", () => {
  const today = "2026-10-20"; // a Tuesday
  const w = calendarView({ view: "week", date: today }, today);
  assert.deepEqual([w.from, w.to], ["2026-10-19", "2026-10-26"]);
  const d = calendarView({ view: "day", date: today }, today);
  assert.deepEqual([d.from, d.to], ["2026-10-20", "2026-10-21"]);
  const four = calendarView({ view: "days", date: today, n: "4" }, today);
  assert.deepEqual([four.view, four.n, four.from, four.to], ["days", 4, "2026-10-20", "2026-10-24"]);
  for (const n of ["2", "7"]) assert.equal(calendarView({ view: "days", date: today, n }, today).n, Number(n));
  for (const n of ["1", "8", "30"]) {
    const v = calendarView({ view: "days", date: today, n }, today);
    assert.ok(v.n === undefined || (v.n >= 2 && v.n <= 7), `n=${n} gives ${v.n}`);
  }
});

test.skip("C3: toolbar buttons and view menu (browser: UI)");
test("C3 (lib): prev/next move by one unit of the view; no date = today", () => {
  const today = "2026-10-20";
  const m = calendarView({ view: "month", date: today }, today);
  assert.match(calendarView({ view: "month", date: dateOf(m.next) }, today).title, /November 2026/);
  assert.match(calendarView({ view: "month", date: dateOf(m.prev) }, today).title, /September 2026/);
  const w = calendarView({ view: "week", date: today }, today);
  assert.equal(calendarView({ view: "week", date: dateOf(w.next) }, today).from, "2026-10-26");
  assert.equal(calendarView({ view: "week", date: dateOf(w.prev) }, today).from, "2026-10-12");
  const d = calendarView({ view: "day", date: today }, today);
  assert.equal(calendarView({ view: "day", date: dateOf(d.next) }, today).from, "2026-10-21");
  assert.equal(calendarView({ view: "day", date: dateOf(d.prev) }, today).from, "2026-10-19");
  const four = calendarView({ view: "days", date: today, n: "4" }, today);
  assert.equal(calendarView({ view: "days", date: dateOf(four.next), n: "4" }, today).from, "2026-10-24");
  assert.equal(calendarView({ view: "days", date: dateOf(four.prev), n: "4" }, today).from, "2026-10-16");
  // Today: the current week / day.
  assert.equal(calendarView({ view: "week" }, today).from, "2026-10-19");
  assert.equal(calendarView({ view: "day" }, today).from, today);
});

test.skip("C4: clicking a week row or day number in Month (browser: links)");
test("C4 (lib): a date opened in Week shows its Monday-start week; in Day, that day", () => {
  const w = calendarView({ view: "week", date: "2026-10-01" }, "2026-10-20"); // a Thursday
  assert.deepEqual([w.from, w.to], ["2026-09-28", "2026-10-05"]);
  const d = calendarView({ view: "day", date: "2026-10-01" }, "2026-10-20");
  assert.deepEqual([d.from, d.to], ["2026-10-01", "2026-10-02"]);
});

test.skip("C5: left panel, mini month, Meet with, My calendars (browser: UI)");
test("C5 (lib): on opening, today is the picked date", () => {
  assert.equal(calendarView({}, "2026-10-20").date, "2026-10-20");
});

test("C6: scheduled (series expanded, skips left out), past sent and waiting ones show; paused, cancelled, rejected, deleted don't", async () => {
  const sched = await make(alice, { title: "C6 scheduled", sendAtLocal: "2031-04-07T09:00", userIds: [alice] });
  const daily = await series(alice, "2031-04-14T09:00", { freq: "daily", interval: 1, end: { type: "count", count: 5 } }, { title: "C6 daily", userIds: [alice] });
  await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, $3, 'skipped')", [
    s.companyId,
    daily,
    iso("2031-04-15T09:00"),
  ]);
  const pending = await make(alice, { title: "C6 pending", sendAtLocal: "2031-04-08T09:00", departmentIds: [sales] });
  assert.equal((await row(pending)).status, "pending_approval");
  const paused = await make(alice, { title: "C6 paused", sendAtLocal: "2031-04-09T09:00", userIds: [alice] });
  await q("update reminders set status = 'paused' where id = $1", [paused]);
  const cancelled = await make(alice, { title: "C6 cancelled", sendAtLocal: "2031-04-09T10:00", userIds: [alice] });
  assert.equal(await cancelReminder(await actor(alice), s.companyId, cancelled), null);
  const rejected = await make(alice, { title: "C6 rejected", sendAtLocal: "2031-04-09T11:00", departmentIds: [sales] });
  assert.equal(await decideReminder(await actor(admin), s.companyId, rejected, false, "no"), null);
  assert.equal((await row(rejected)).status, "rejected");
  const deleted = await make(alice, { title: "C6 deleted", sendAtLocal: "2031-04-09T12:00", userIds: [alice] });
  await q("update reminders set deleted_at = now(), status = 'cancelled' where id = $1", [deleted]);

  const r = await range(alice, "2031-04-01", "2031-05-01");
  assert.deepEqual(shape(r, sched), [["2031-04-07", iso("2031-04-07T09:00"), "scheduled"]]);
  assert.deepEqual(
    shape(r, daily).map((x) => x[0]),
    ["2031-04-14", "2031-04-16", "2031-04-17", "2031-04-18"],
    "series expanded, the skipped 15th left out",
  );
  assert.deepEqual(shape(r, pending), [["2031-04-08", iso("2031-04-08T09:00"), "pending"]], "waiting for approval shows, marked");
  for (const [label, id] of Object.entries({ paused, cancelled, rejected, deleted })) assert.equal(of(r, id).length, 0, `${label} hidden`);

  const sent = await make(alice, { title: "C6 sent", sendAtLocal: "2031-04-10T09:00", userIds: [alice] });
  await sentPast(sent, "2026-09-14T09:00", [alice]);
  const past = await range(alice, "2026-09-01", "2026-10-01");
  assert.deepEqual(shape(past, sent), [["2026-09-14", iso("2026-09-14T09:00"), "sent"]], "a past send shows as sent");
});

test("C7: times and days in the viewer's zone, whatever the reminder's zone", async () => {
  const late = await make(alice, { title: "C7 late", sendAtLocal: "2031-03-03T22:00", userIds: [alice] }); // 22:00 UTC
  const dubai = await range(alice, "2031-03-03", "2031-03-05", { tz: "Asia/Dubai" });
  assert.deepEqual(shape(dubai, late), [["2031-03-04", iso("2031-03-03T22:00"), "scheduled"]], "02:00 on the 4th in Dubai");
  const r = await createReminder(await actor(alice), s.companyId, input({ title: "C7 NY", sendAtLocal: "2031-03-03T20:00", userIds: [alice] }, {}, "America/New_York"));
  assert.ok("id" in r, JSON.stringify(r));
  const utc = await range(alice, "2031-03-03", "2031-03-05");
  assert.deepEqual(shape(utc, r.id), [["2031-03-04", "2031-03-04T01:00:00.000Z", "scheduled"]], "20:00 New York = 01:00 UTC next day");
});

test("C8: each entry has its layers; it hides only when all its layers are off; 'everything else' catches the rest", async () => {
  // Sent in the past so recipients can open them.
  const mine = await make(alice, { title: "C8 mine", sendAtLocal: "2031-03-10T09:00", userIds: [alice] });
  const assigned = await make(bob, { title: "C8 assigned", sendAtLocal: "2031-03-10T09:00", userIds: [alice] }, { isTask: true, dueAfterMinutes: 60 });
  await sentPast(assigned, "2026-09-01T09:00", [alice], true);
  const deptOne = await make(bob, { title: "C8 dept", sendAtLocal: "2031-03-10T09:00", departmentIds: [ops] });
  await sentPast(deptOne, "2026-09-02T09:00", [alice, bob]);
  const companyOne = await make(admin, { title: "C8 company", sendAtLocal: "2031-03-10T09:00", company: true });
  await sentPast(companyOne, "2026-09-03T09:00", [alice, bob, carol, dave]);
  const direct = await make(bob, { title: "C8 direct", sendAtLocal: "2031-03-10T09:00", userIds: [alice] });
  await sentPast(direct, "2026-09-04T09:00", [alice]);
  const both = await make(alice, { title: "C8 both", sendAtLocal: "2031-03-10T09:00", userIds: [alice] }, { isTask: true, dueAfterMinutes: 60 });
  await sentPast(both, "2026-09-05T09:00", [alice], true);
  const bobsPrivate = await make(bob, { title: "C8 bob private", sendAtLocal: "2031-03-11T09:00", userIds: [bob] });

  const r = await range(alice, "2026-09-01", "2026-09-08");
  const L = (id: string) => one(r, id).layers;
  assert.ok(L(assigned).includes("assigned"), `assigned task: ${L(assigned)}`);
  assert.ok(!L(assigned).includes("other"));
  assert.ok(L(deptOne).includes("departments"), `to my department: ${L(deptOne)}`);
  assert.ok(!L(deptOne).includes("other"));
  assert.ok(L(companyOne).includes("company"), `company-wide: ${L(companyOne)}`);
  assert.ok(!L(companyOne).includes("other"));
  assert.deepEqual(L(direct), ["other"], "sent to me directly: everything else");
  assert.ok(L(both).includes("mine") && L(both).includes("assigned"), `in two layers: ${L(both)}`);
  const e = one(r, both);
  assert.equal(shownOn(e, new Set(["mine"])), true);
  assert.equal(shownOn(e, new Set(["assigned"])), true);
  assert.equal(shownOn(e, new Set(["departments", "company", "other"])), false, "hidden when all its layers are off");
  assert.equal(shownOn(e, new Set()), false);
  // Every entry can be hidden.
  for (const { e: x } of flat(r)) assert.equal(shownOn(x, new Set()), false, `${x.title} hides with all layers off`);

  const future = await range(alice, "2031-03-10", "2031-03-11");
  assert.ok(one(future, mine).layers.includes("mine"));
  const seenAll = await range(editor, "2031-03-11", "2031-03-12");
  assert.deepEqual(one(seenAll, bobsPrivate).layers, ["other"], "seen through view all: everything else");
});

test("C9: search by title, tag and a person's name; only what the viewer can see; next first", async () => {
  await q(`update "user" set name = 'Bartholomew Zest' where id = $1`, [bob]);
  await q(`update "user" set name = 'Dorothea Quill' where id = $1`, [dave]);
  const later = await make(alice, { title: "C9 Pelican later", sendAtLocal: "2031-05-01T09:00", userIds: [alice] });
  const sooner = await make(alice, { title: "C9 Pelican sooner", sendAtLocal: "2031-04-01T09:00", userIds: [alice] });
  const tagged = await make(alice, { title: "C9 tagged", sendAtLocal: "2031-04-02T09:00", userIds: [alice], tags: "zzcalendartag" });
  const byBob = await make(bob, { title: "C9 by bob", sendAtLocal: "2031-04-03T09:00", userIds: [bob], shareDepartmentIds: [ops] });
  const toDave = await make(alice, { title: "C9 to dave", sendAtLocal: "2031-04-04T09:00", userIds: [dave] });
  const ids = async (who: string, text: string) =>
    // The calendar searches soonest first (decided 2026-10-20: C9 is about the calendar, not the Reminders list's default).
    (await searchReminders(s.companyId, await actor(who), TZ, { ...parseFilters({ q: text }), sort: "send_asc" })).rows.map((x) => (x as { id: string }).id);

  const pel = await ids(alice, "Pelican");
  assert.ok(pel.includes(later) && pel.includes(sooner), "by title");
  assert.ok(pel.indexOf(sooner) < pel.indexOf(later), "next first");
  assert.ok((await ids(alice, "zzcalendartag")).includes(tagged), "by tag");
  assert.ok((await ids(alice, "Bartholomew")).includes(byBob), "by creator's name");
  assert.ok((await ids(alice, "Quill")).includes(toDave), "by recipient's name");
  assert.ok(!(await ids(carol, "Bartholomew")).includes(byBob), "not for someone who can't see it");
  assert.ok(!(await ids(carol, "Pelican")).includes(sooner));
});

test("C10: a colleague's calendar adds their entries, outlined, only those the viewer could already open", async () => {
  const bobPrivate = await make(bob, { title: "C10 bob private", sendAtLocal: "2031-03-12T09:00", userIds: [bob] });
  const bobShared = await make(bob, { title: "C10 bob shared", sendAtLocal: "2031-03-12T10:00", userIds: [bob], shareDepartmentIds: [ops] });
  const daveToBob = await make(dave, { title: "C10 dave to bob", sendAtLocal: "2031-03-12T11:00", userIds: [bob] });
  const aliceToBob = await make(alice, { title: "C10 alice to bob", sendAtLocal: "2031-03-12T12:00", userIds: [bob] });
  const r = await range(alice, "2031-03-12", "2031-03-13", { person: bob });
  assert.equal(of(r, bobPrivate).length, 0, "a colleague's private reminder never shows");
  assert.equal(of(r, daveToBob).length, 0, "sent to them but not openable by me");
  assert.equal(one(r, bobShared).theirs, true, "their entry, outlined");
  assert.equal(of(r, aliceToBob).length, 1, "mine, sent to them, still shows");
  const plain = await range(alice, "2031-03-12", "2031-03-13");
  assert.ok(flat(plain).every((x) => !x.e.theirs), "nobody picked: nothing outlined");
});

test.skip("C11: '+N more' in a Month cell (browser: UI)");

test("C12: more than 500 reminders: the first 500 are shown and the result says it was cut", async () => {
  const creator = await big.user({ roles: [MEMBER_ROLE_ID] });
  // 501 one-time reminders, one an hour from 2035-01-01 00:00 UTC.
  await big.owner.query(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, time_zone, anchor_local, status)
     select $1, 'C12-' || substr(md5(random()::text || g::text), 1, 12), $2, 'Bulk ' || g, 'A',
            timestamptz '2035-01-01 00:00Z' + (g || ' hours')::interval, 'UTC',
            to_char(timestamp '2035-01-01 00:00' + (g || ' hours')::interval, 'YYYY-MM-DD"T"HH24:MI'), 'scheduled'
     from generate_series(0, 500) g`,
    [big.companyId, creator],
  );
  const r = await calendarRange(big.companyId, { id: creator, access: await loadAccess(big.companyId, creator) }, TZ, { from: "2035-01-01", to: "2035-02-01" });
  assert.ok(r);
  assert.equal(CALENDAR_LIMIT, 500);
  const ids = new Set(flat(r).map((x) => x.e.reminderId));
  assert.equal(ids.size, CALENDAR_LIMIT);
  assert.equal(r.truncated, true);
  assert.ok(!flat(r).some((x) => x.e.title === "Bulk 500"), "the 501st (latest) is the one left out");
  assert.ok(flat(r).some((x) => x.e.title === "Bulk 0"));
});

test.skip("C13: a member without reminders.create or view_all gets 404 (browser: page guard, requireMember/can in the page)");

// --- Quick create (14.2) ------------------------------------------------------------------

test.skip("Q1: clicking a slot opens the quick box, prefilled (browser: UI)");

test("Q2: quick create makes a scheduled one-time reminder to yourself, by email, shown at once", async () => {
  const when = at("2031-03-20T09:30");
  const r = await quickCreate(await actor(dave), s.companyId, { title: "Q2 quick", at: when, kind: "reminder", timeZone: TZ, senderName: "D" });
  assert.ok("id" in r, JSON.stringify(r));
  const x = await row(r.id);
  assert.equal(x.created_by, dave);
  assert.equal(x.recurrence, null, "one-time");
  assert.equal(x.status, "scheduled", "no approval: yourself is always in scope");
  assert.equal((x.send_at as Date).toISOString(), when.toISOString());
  assert.deepEqual(x.channels, ["email"]);
  assert.equal(x.is_task, false);
  const t = await targets(r.id);
  assert.ok(
    t.length === 1 && (t[0] === `user:${dave}` || t[0] === `email:${dave}@${s.domain}`),
    `only to yourself: ${JSON.stringify(t)}`,
  );
  const cal = await range(dave, "2031-03-20", "2031-03-21");
  assert.deepEqual(shape(cal, r.id), [["2031-03-20", when.toISOString(), "scheduled"]]);
});

test("Q3: a quick task is also assigned to you, due 1 hour after it's sent", async () => {
  const r = await quickCreate(await actor(alice), s.companyId, { title: "Q3 task", at: at("2031-03-20T10:00"), kind: "task", timeZone: TZ, senderName: "A" });
  assert.ok("id" in r, JSON.stringify(r));
  const x = await row(r.id);
  assert.equal(x.is_task, true);
  assert.equal(x.due_after_minutes, 60);
  assert.equal(x.status, "scheduled");
  const t = await targets(r.id);
  assert.ok(t.includes(`user:${alice}`), `assigned to you (a user target): ${JSON.stringify(t)}`);
});

test("Q4: empty title, a past time or an over-long title are refused; nothing created", async () => {
  const a = await actor(alice);
  const count = await reminderCount();
  const cases = {
    empty: { title: "   ", at: at("2031-03-21T09:00") },
    past: { title: "Q4 past", at: new Date(Date.now() - 3_600_000) },
    long: { title: "x".repeat(1000), at: at("2031-03-21T09:00") },
  };
  for (const [label, c] of Object.entries(cases)) {
    const r = await quickCreate(a, s.companyId, { ...c, kind: "reminder", timeZone: TZ, senderName: "A" });
    assert.ok("error" in r && r.error, `${label}: refused`);
  }
  assert.equal(await reminderCount(), count, "nothing created");
});

test.skip("Q5: 'More options' opens the full form prefilled (browser: form prefill is not a lib function)");
test.skip("Q6: Esc or clicking outside closes the box (browser: UI)");

// --- Peek card (14.2) ---------------------------------------------------------------------

test("K1: entry carries title, time, repeat summary, and recipients only for a viewer with full access", async () => {
  const s1 = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "K1 weekly", departmentIds: [ops] });
  const once = await make(alice, { title: "K1 once", sendAtLocal: "2031-03-04T09:00", departmentIds: [ops] });
  const r = await range(alice, "2031-03-03", "2031-03-05");
  const e = one(r, s1);
  assert.equal(e.title, "K1 weekly");
  assert.equal(e.at.toISOString(), iso("2031-03-03T09:00"));
  assert.ok(e.repeat && e.repeat.length > 0, `repeat summary for a series: ${e.repeat}`);
  assert.equal(one(r, once).repeat, null, "no summary for a one-time reminder");
  assert.ok(e.recipients && e.recipients.length > 0, "creator sees the recipients");

  const sent = await make(bob, { title: "K1 sent to alice", sendAtLocal: "2031-03-04T09:00", userIds: [alice] });
  await sentPast(sent, "2026-09-08T09:00", [alice]);
  const asRecipient = one(await range(alice, "2026-09-08", "2026-09-09"), sent);
  assert.equal(asRecipient.recipients, null, "a recipient without full access sees no recipient list");
  const asCreator = one(await range(bob, "2026-09-08", "2026-09-09"), sent);
  assert.ok(asCreator.recipients && asCreator.recipients.length > 0);
});

test("K2: canChange follows who may change it; assignment only for an assignee of a sent task", async () => {
  const id = await make(alice, { title: "K2", sendAtLocal: "2031-03-05T09:00", departmentIds: [ops], shareDepartmentIds: [ops] });
  const canChange = async (who: string) => one(await range(who, "2031-03-05", "2031-03-06"), id).canChange;
  assert.equal(await canChange(alice), true, "creator");
  assert.equal(await canChange(admin), true, "admin");
  assert.equal(await canChange(editor), true, "editor who can see it in full");
  assert.equal(await canChange(bob), false, "a colleague it's shared with");
  assert.equal(of(await range(blindEditor, "2031-03-05", "2031-03-06"), id).length, 0, "an editor who can't see it doesn't get it");
  assert.equal(one(await range(alice, "2031-03-05", "2031-03-06"), id).assignment, null, "not a sent task");

  const task = await make(alice, { title: "K2 task", sendAtLocal: "2031-03-05T09:00", userIds: [bob] }, { isTask: true, dueAfterMinutes: 60 });
  await sentPast(task, "2026-09-09T09:00", [bob], true);
  const bobs = one(await range(bob, "2026-09-09", "2026-09-10"), task);
  assert.ok(bobs.assignment, "the assignee can mark it done");
  assert.equal(bobs.assignment.done, false);
  assert.equal(one(await range(alice, "2026-09-09", "2026-09-10"), task).assignment, null, "the creator isn't an assignee");
  await q("update task_assignments set done_at = now() where reminder_id = $1", [task]);
  assert.equal(one(await range(bob, "2026-09-09", "2026-09-10"), task).assignment?.done, true, "Undo after done");
});

test("K3: a sent entry: no Edit, Move or Delete of that occurrence; Duplicate and Mark done still work", async () => {
  const task = await make(alice, { title: "K3 sent task", sendAtLocal: "2031-03-06T09:00", userIds: [alice] }, { isTask: true, dueAfterMinutes: 60 });
  await sentPast(task, "2026-09-10T09:00", [alice], true);
  const e = one(await range(alice, "2026-09-10", "2026-09-11"), task);
  assert.equal(e.state, "sent");
  assert.ok(e.assignment, "Mark done for its assignee");
  const a = await actor(alice);
  const dup = await duplicateReminder(a, s.companyId, task, at("2031-03-07T09:00"));
  assert.ok("id" in dup, `duplicate allowed: ${JSON.stringify(dup)}`);
  const before = await row(task);
  const moved = await moveEntry(a, s.companyId, task, e.at, at("2031-03-07T09:00"), "one");
  assert.ok("error" in moved, "move of that occurrence refused");
  const after = await row(task);
  assert.deepEqual([after.send_at, after.status, after.deleted_at], [before.send_at, before.status, before.deleted_at], "unchanged");
  // No Delete on the card for a sent entry is a browser check. Deleting the reminder itself stays
  // allowed for its creator (D1), so deleteEntry isn't expected to refuse (decided 2026-10-20).
});

test.skip("K4: entries focusable, Enter opens the card, Esc returns focus (browser: keyboard)");

// --- Move, edit and delete (14.2) ----------------------------------------------------------

test("M1: moving a one-time reminder: it sends at the new time; recipients and approval unchanged", async () => {
  const id = await make(alice, { title: "M1", sendAtLocal: "2031-03-03T09:00", departmentIds: [sales] });
  assert.equal(await decideReminder(await actor(admin), s.companyId, id, true), null);
  const before = await row(id);
  assert.equal(before.status, "scheduled");
  const tBefore = await targets(id);
  const r = await moveEntry(await actor(alice), s.companyId, id, at("2031-03-03T09:00"), at("2031-03-04T14:30"), "all");
  assert.ok("id" in r, JSON.stringify(r));
  assert.equal(r.id, id, "the same reminder");
  const x = await row(id);
  assert.equal((x.send_at as Date).toISOString(), iso("2031-03-04T14:30"));
  assert.equal(x.status, "scheduled", "approval unchanged");
  assert.equal(x.decided_by, before.decided_by);
  assert.deepEqual(await targets(id), tBefore, "recipients unchanged");
  assert.deepEqual(shape(await range(alice, "2031-03-01", "2031-03-08"), id), [["2031-03-04", iso("2031-03-04T14:30"), "scheduled"]]);
});

test("M2: dropping on a past time is refused; nothing changes", async () => {
  const id = await make(alice, { title: "M2", sendAtLocal: "2031-03-03T09:00", userIds: [alice] });
  const before = await row(id);
  const r = await moveEntry(await actor(alice), s.companyId, id, at("2031-03-03T09:00"), new Date(Date.now() - 3_600_000), "all");
  assert.ok("error" in r);
  assert.deepEqual((await row(id)).send_at, before.send_at);
  const sid = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "M2 series", userIds: [alice] });
  const count = await reminderCount();
  for (const scope of ["one", "following", "all"] as const) {
    const m = await moveEntry(await actor(alice), s.companyId, sid, at("2031-03-10T09:00"), new Date(Date.now() - 3_600_000), scope);
    assert.ok("error" in m, `${scope}: refused`);
  }
  assert.equal(await reminderCount(), count, "no split made");
  assert.deepEqual(shape(await range(alice, "2031-03-01", "2031-03-15"), sid).map((x) => x[1]), [iso("2031-03-03T09:00"), iso("2031-03-10T09:00")]);
});

test("M3: someone who may not change it is refused ('not found')", async () => {
  const id = await make(alice, { title: "M3", sendAtLocal: "2031-03-03T09:00", departmentIds: [ops], shareDepartmentIds: [ops] });
  const before = await row(id);
  for (const who of [bob, carol, blindEditor]) {
    const r = await moveEntry(await actor(who), s.companyId, id, at("2031-03-03T09:00"), at("2031-03-05T09:00"), "all");
    assert.ok("error" in r, `${who}: refused`);
    assert.match(r.error, /not found/i);
  }
  assert.deepEqual((await row(id)).send_at, before.send_at);
});

test("M4: 'Move to…' by an editor who can't create reminders works the same as a drag", async () => {
  const id = await make(alice, { title: "M4", sendAtLocal: "2031-03-03T09:00", departmentIds: [ops] });
  const r = await moveEntry(await actor(moverOnly), s.companyId, id, at("2031-03-03T09:00"), at("2031-03-06T16:00"), "all");
  assert.ok("id" in r, JSON.stringify(r));
  assert.equal(((await row(id)).send_at as Date).toISOString(), iso("2031-03-06T16:00"));
  assert.equal((await row(id)).status, "scheduled");
});

test.skip("M5: dragging a series occurrence asks This one / following / All; Esc cancels (browser: drag gesture and dialog)");

test("M6: This one: that occurrence becomes its own one-time reminder (creator kept); the series skips that date", async () => {
  const sid = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "M6", description: "Series text", departmentIds: [ops] });
  const r = await moveEntry(await actor(editor), s.companyId, sid, at("2031-03-17T09:00"), at("2031-03-18T11:00"), "one");
  assert.ok("id" in r, JSON.stringify(r));
  assert.notEqual(r.id, sid);
  const c = await row(r.id);
  assert.equal(c.recurrence, null, "one-time");
  assert.equal((c.send_at as Date).toISOString(), iso("2031-03-18T11:00"));
  assert.equal(c.title, "M6");
  assert.equal(c.description, "Series text");
  assert.equal(c.created_by, alice, "creator is the series' creator, not the editor");
  assert.equal(c.status, "scheduled");
  assert.deepEqual(await targets(r.id), await targets(sid));
  const cal = await range(alice, "2031-03-01", "2031-04-01");
  assert.deepEqual(
    shape(cal, sid).map((x) => x[0]),
    ["2031-03-03", "2031-03-10", "2031-03-24", "2031-03-31"],
    "the series skips the 17th",
  );
  assert.deepEqual(shape(cal, r.id), [["2031-03-18", iso("2031-03-18T11:00"), "scheduled"]]);
});

test("M7: This and following: the series ends before it; a new series from it with the same rule and content; approval carries over", async () => {
  const sid = await series(
    alice,
    "2031-03-03T09:00",
    WEEKLY_MON,
    { title: "M7", description: "Weekly text", departmentIds: [sales], tags: "mseven", linkLabels: ["Doc"], linkUrls: ["https://example.com/doc"], shareDepartmentIds: [ops] },
    {},
    [file("notes.txt", "notes")],
  );
  assert.equal((await row(sid)).status, "pending_approval");
  assert.equal(await decideReminder(await actor(admin), s.companyId, sid, true), null);
  assert.equal(await setMyColor(await actor(alice), s.companyId, sid, "grape"), null);
  await q("insert into comments (company_id, reminder_id, author_id, body) values ($1, $2, $3, 'on the original')", [s.companyId, sid, alice]);

  const r = await moveEntry(await actor(alice), s.companyId, sid, at("2031-03-17T09:00"), at("2031-03-17T11:00"), "following");
  assert.ok("id" in r, JSON.stringify(r));
  assert.notEqual(r.id, sid, "the new series has its own id");
  const n = await row(r.id);
  const o = await row(sid);
  assert.deepEqual(n.recurrence, o.recurrence === null ? n.recurrence : { ...o.recurrence, end: n.recurrence.end }, "same rule (apart from the end)");
  assert.equal(n.recurrence.freq, "weekly");
  assert.equal(n.status, "scheduled", "approval carries over (same recipients)");
  assert.deepEqual([n.title, n.description, n.links, n.tags, n.channels, n.is_task], [o.title, o.description, o.links, o.tags, o.channels, o.is_task]);
  assert.deepEqual(await targets(r.id), await targets(sid), "same recipients");
  assert.deepEqual(await shares(r.id), await shares(sid), "same sharing");
  assert.deepEqual(await fileNames(r.id), ["notes.txt"], "files copied");
  assert.equal((await q("select 1 from comments where reminder_id = $1", [r.id])).length, 0, "comments stay on the original");

  const cal = await range(alice, "2031-03-01", "2031-04-08");
  assert.deepEqual(shape(cal, sid).map((x) => x[1]), [iso("2031-03-03T09:00"), iso("2031-03-10T09:00")], "the series ends before the 17th");
  assert.deepEqual(
    shape(cal, r.id).map((x) => x[1]),
    [iso("2031-03-17T11:00"), iso("2031-03-24T11:00"), iso("2031-03-31T11:00"), iso("2031-04-07T11:00")],
    "the new series from the 17th at the new time",
  );
  // Colours are personal now: the mover's own colour is the reading of "same … colour".
  const colours = await q("select user_id, color from reminder_colors where reminder_id = $1", [r.id]);
  assert.deepEqual(colours.map((c) => [c.user_id, c.color]), [[alice, "grape"]], "my colour carries over");
});

test("M8: All: the whole series shifts by the same amount (Monday 09:00 → Tuesday 10:00); sent ones stay", async () => {
  const sid = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "M8", userIds: [alice] });
  // The first occurrence already went out; the schedule moved on to the 10th.
  const occ = await addSent(sid, "2031-03-03T09:00", [alice]);
  await q("update reminders set send_at = $2 where id = $1", [sid, iso("2031-03-10T09:00")]);
  const r = await moveEntry(await actor(alice), s.companyId, sid, at("2031-03-10T09:00"), at("2031-03-11T10:00"), "all");
  assert.ok("id" in r, JSON.stringify(r));
  const x = await row(sid);
  const holder = await row(r.id);
  assert.equal(holder.recurrence.freq, "weekly");
  if (holder.recurrence.weekdays) assert.deepEqual(holder.recurrence.weekdays, [1], "Monday → Tuesday");
  const cal = await range(alice, "2031-03-09", "2031-04-01");
  const times = flat(cal)
    .filter((y) => y.e.reminderId === sid || y.e.reminderId === r.id)
    .map((y) => y.e.at.toISOString())
    .sort();
  assert.deepEqual(times, [iso("2031-03-11T10:00"), iso("2031-03-18T10:00"), iso("2031-03-25T10:00")], "every Tuesday 10:00, no Mondays");
  const sentRow = await q("select occurs_at, status from reminder_occurrences where id = $1", [occ]);
  assert.deepEqual(sentRow.map((o) => [(o.occurs_at as Date).toISOString(), o.status]), [[iso("2031-03-03T09:00"), "sent"]], "the sent one stays");
  assert.ok(x, "series row still there");
});

test("M9: This one / following / all work on an occurrence that isn't the next one", async () => {
  const a = await actor(alice);
  const s1 = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "M9 one", userIds: [alice] });
  const one1 = await moveEntry(a, s.companyId, s1, at("2031-03-24T09:00"), at("2031-03-24T15:00"), "one");
  assert.ok("id" in one1, `one: ${JSON.stringify(one1)}`);
  const s2 = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "M9 following", userIds: [alice] });
  const f = await moveEntry(a, s.companyId, s2, at("2031-03-24T09:00"), at("2031-03-24T15:00"), "following");
  assert.ok("id" in f, `following: ${JSON.stringify(f)}`);
  const s3 = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "M9 all", userIds: [alice] });
  const all = await moveEntry(a, s.companyId, s3, at("2031-03-24T09:00"), at("2031-03-24T15:00"), "all");
  assert.ok("id" in all, `all: ${JSON.stringify(all)}`);
  const cal = await range(alice, "2031-03-01", "2031-03-31");
  assert.deepEqual(
    flat(cal).filter((y) => y.e.reminderId === s1 || y.e.reminderId === one1.id).map((y) => y.e.at.toISOString()).sort(),
    [iso("2031-03-03T09:00"), iso("2031-03-10T09:00"), iso("2031-03-17T09:00"), iso("2031-03-24T15:00")],
  );
  assert.deepEqual(
    flat(cal).filter((y) => y.e.reminderId === s3 || y.e.reminderId === all.id).map((y) => y.e.at.toISOString()).sort(),
    [iso("2031-03-03T15:00"), iso("2031-03-10T15:00"), iso("2031-03-17T15:00"), iso("2031-03-24T15:00")],
    "all: every occurrence moved by 6 hours",
  );
});

test("M10: waiting for approval: one-time and All moves work and it still waits; This one / following refused", async () => {
  const a = await actor(alice);
  const once = await make(alice, { title: "M10 once", sendAtLocal: "2031-03-03T09:00", departmentIds: [sales] });
  assert.equal((await row(once)).status, "pending_approval");
  const m = await moveEntry(a, s.companyId, once, at("2031-03-03T09:00"), at("2031-03-04T09:00"), "all");
  assert.ok("id" in m, JSON.stringify(m));
  assert.equal(((await row(once)).send_at as Date).toISOString(), iso("2031-03-04T09:00"));
  assert.equal((await row(once)).status, "pending_approval", "still waiting");

  const sid = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "M10 series", departmentIds: [sales] });
  assert.equal((await row(sid)).status, "pending_approval");
  const count = await reminderCount();
  for (const scope of ["one", "following"] as const) {
    const r = await moveEntry(a, s.companyId, sid, at("2031-03-10T09:00"), at("2031-03-10T10:00"), scope);
    assert.ok("error" in r, `${scope}: refused while waiting`);
  }
  assert.equal(await reminderCount(), count, "no split");
  const all = await moveEntry(a, s.companyId, sid, at("2031-03-10T09:00"), at("2031-03-10T10:00"), "all");
  assert.ok("id" in all, JSON.stringify(all));
  assert.equal((await row(all.id)).status, "pending_approval", "still waiting");
  assert.deepEqual(
    shape(await range(alice, "2031-03-01", "2031-03-15"), all.id),
    [
      ["2031-03-03", iso("2031-03-03T10:00"), "pending"],
      ["2031-03-10", iso("2031-03-10T10:00"), "pending"],
    ],
  );
});

test.skip("M11: Edit from the card on a series offers the three choices and opens the form (browser: form; editOccurrence is not in this test's API)");

test("M12: delete This one = skip that date; following = the series ends before it; All = deleted everywhere", async () => {
  const a = await actor(alice);
  const s1 = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "M12 one", userIds: [alice] });
  const s2 = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "M12 following", userIds: [alice] });
  const s3 = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "M12 all", userIds: [alice] });
  assert.equal(await deleteEntry(a, s.companyId, s1, at("2031-03-17T09:00"), "one"), null);
  assert.equal(await deleteEntry(a, s.companyId, s2, at("2031-03-17T09:00"), "following"), null);
  assert.equal(await deleteEntry(a, s.companyId, s3, at("2031-03-17T09:00"), "all"), null);
  const cal = await range(alice, "2031-03-01", "2031-04-01");
  assert.deepEqual(shape(cal, s1).map((x) => x[0]), ["2031-03-03", "2031-03-10", "2031-03-24", "2031-03-31"], "one: that date skipped");
  assert.deepEqual(shape(cal, s2).map((x) => x[0]), ["2031-03-03", "2031-03-10"], "following: ends before it");
  assert.equal(of(cal, s3).length, 0, "all: gone from the calendar");
  assert.ok((await row(s3)).deleted_at, "all: soft-deleted (hidden everywhere)");
  assert.equal((await row(s1)).deleted_at, null);
  assert.equal((await row(s2)).deleted_at, null);
  assert.ok(await deleteEntry(await actor(carol), s.companyId, s1, at("2031-03-24T09:00"), "one"), "someone who may not change it is refused");
});

test("M13: a drag never changes recipients, so it never needs approval (approved series, This one)", async () => {
  const sid = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "M13", departmentIds: [sales] });
  assert.equal(await decideReminder(await actor(admin), s.companyId, sid, true), null);
  const r = await moveEntry(await actor(alice), s.companyId, sid, at("2031-03-10T09:00"), at("2031-03-11T09:00"), "one");
  assert.ok("id" in r, JSON.stringify(r));
  assert.deepEqual(await targets(r.id), await targets(sid), "same recipients");
  assert.equal((await row(r.id)).status, "scheduled", "no new approval");
  const f = await moveEntry(await actor(alice), s.companyId, sid, at("2031-03-17T09:00"), at("2031-03-17T10:00"), "following");
  assert.ok("id" in f, JSON.stringify(f));
  assert.deepEqual(await targets(f.id), await targets(sid));
  assert.equal((await row(f.id)).status, "scheduled");
});

// Probed 2026-10-20: after an editor's move, split and delete no audit_log row
// exists at all. Outside a signed-in request withTenant has no actor and logs
// nothing (src/db/index.ts), the same reason D11 is browser-only.
test.skip("M14: each move, split and delete is logged as the person who did it (browser: the actor comes from the signed-in request, as D11)");

// --- Duplicate (14.2) ---------------------------------------------------------------------

test("U1: a duplicate is a one-time copy with the same content, recipients, files, sharing and task settings, but no colour", async () => {
  const sid = await series(
    alice,
    "2031-03-03T09:00",
    WEEKLY_MON,
    { title: "U1", description: "Copy me", departmentIds: [ops], tags: "uone", linkLabels: ["Doc"], linkUrls: ["https://example.com/u1"], shareDepartmentIds: [sales] },
    { isTask: true, dueAfterMinutes: 90 },
    [file("u1.txt", "u1")],
  );
  assert.equal(await setMyColor(await actor(alice), s.companyId, sid, "grape"), null);
  assert.equal(await setMyColor(await actor(carol), s.companyId, sid, "basil"), null, "carol (shared via Sales) can open it");
  const when = at("2031-06-02T14:00");
  const r = await duplicateReminder(await actor(alice), s.companyId, sid, when);
  assert.ok("id" in r, JSON.stringify(r));
  const c = await row(r.id);
  const o = await row(sid);
  assert.notEqual(r.id, sid);
  assert.equal(c.recurrence, null, "always one-time");
  assert.equal((c.send_at as Date).toISOString(), when.toISOString());
  assert.deepEqual(
    [c.title, c.description, c.links, c.tags, c.channels, c.is_task, c.due_after_minutes],
    [o.title, o.description, o.links, o.tags, o.channels, o.is_task, o.due_after_minutes],
  );
  assert.deepEqual(await targets(r.id), await targets(sid), "same recipients");
  assert.deepEqual(await shares(r.id), await shares(sid), "same sharing");
  assert.deepEqual(await fileNames(r.id), ["u1.txt"], "files copied");
  assert.deepEqual(await q("select user_id from reminder_colors where reminder_id = $1", [r.id]), [], "nobody's colour copied");
});

test("U2: the duplicate belongs to whoever duplicated it; approval is checked as them", async () => {
  const wide = await make(admin, { title: "U2 company-wide", sendAtLocal: "2031-03-03T09:00", company: true, shareCompany: true });
  assert.equal((await row(wide)).status, "scheduled");
  const r = await duplicateReminder(await actor(alice), s.companyId, wide, at("2031-03-10T09:00"));
  assert.ok("id" in r, JSON.stringify(r));
  const c = await row(r.id);
  assert.equal(c.created_by, alice);
  assert.equal(c.status, "pending_approval", "a member sending company-wide needs approval");
  const mine = await make(alice, { title: "U2 mine", sendAtLocal: "2031-03-03T09:00", departmentIds: [ops] });
  const d = await duplicateReminder(await actor(alice), s.companyId, mine, at("2031-03-10T09:00"));
  assert.ok("id" in d);
  assert.equal((await row(d.id)).status, "scheduled", "in scope: scheduled");
});

test("U3: comments, delivery history and task completion are not copied", async () => {
  const id = await make(alice, { title: "U3", sendAtLocal: "2031-03-03T09:00", userIds: [bob] }, { isTask: true, dueAfterMinutes: 60 });
  await sentPast(id, "2026-09-11T09:00", [bob], true);
  await q("update task_assignments set done_at = now() where reminder_id = $1", [id]);
  await q("insert into comments (company_id, reminder_id, author_id, body) values ($1, $2, $3, 'hi')", [s.companyId, id, alice]);
  const r = await duplicateReminder(await actor(alice), s.companyId, id, at("2031-03-10T09:00"));
  assert.ok("id" in r, JSON.stringify(r));
  for (const t of ["comments", "reminder_occurrences", "deliveries", "task_assignments"])
    assert.equal((await q(`select 1 from ${t} where reminder_id = $1`, [r.id])).length, 0, `${t} not copied`);
  assert.equal((await row(r.id)).status, "scheduled");
  assert.equal((await q("select 1 from comments where reminder_id = $1", [id])).length, 1, "original keeps its comment");
});

test("U4: you may duplicate what you can only view, if you can create reminders", async () => {
  const id = await make(bob, { title: "U4", sendAtLocal: "2031-03-03T09:00", userIds: [bob], shareDepartmentIds: [ops] });
  const m = await moveEntry(await actor(alice), s.companyId, id, at("2031-03-03T09:00"), at("2031-03-04T09:00"), "all");
  assert.ok("error" in m, "alice can only view it");
  const r = await duplicateReminder(await actor(alice), s.companyId, id, at("2031-03-10T09:00"));
  assert.ok("id" in r, JSON.stringify(r));
  assert.equal((await row(r.id)).created_by, alice);
  const count = await reminderCount();
  const no1 = await duplicateReminder(await actor(carol), s.companyId, id, at("2031-03-10T09:00"));
  assert.ok("error" in no1, "can't open it: refused");
  const no2 = await duplicateReminder(await actor(viewOnly), s.companyId, id, at("2031-03-10T09:00"));
  assert.ok("error" in no2, "can see it but can't create reminders: refused");
  assert.equal(await reminderCount(), count);
});

// --- Colours (14.2) -----------------------------------------------------------------------

test.skip("L1: palette contrast ≥ 4.5:1 in both themes (browser: CSS colours)");
test("L1 (lib): the 11 named colours are accepted, anything else refused", async () => {
  const id = await make(alice, { title: "L1", sendAtLocal: "2031-03-03T09:00", userIds: [alice] });
  const a = await actor(alice);
  const names = ["tomato", "flamingo", "tangerine", "banana", "sage", "basil", "peacock", "blueberry", "lavender", "grape", "graphite"];
  for (const c of names) assert.equal(await setMyColor(a, s.companyId, id, c), null, `${c} accepted`);
  assert.ok(await setMyColor(a, s.companyId, id, "chartreuse"), "unknown colour refused");
  assert.deepEqual((await q("select color from reminder_colors where reminder_id = $1", [id])).map((x) => x.color), ["graphite"], "unchanged by the refusal");
});

test("L2: a picked colour is mine only, on every occurrence; Reset goes back to the default", async () => {
  const sid = await series(alice, "2031-03-03T09:00", WEEKLY_MON, { title: "L2", departmentIds: [ops], shareDepartmentIds: [ops] });
  assert.equal(await setMyColor(await actor(alice), s.companyId, sid, "tomato"), null);
  const mine = of(await range(alice, "2031-03-01", "2031-03-25"), sid);
  assert.equal(mine.length, 4);
  for (const { e } of mine) {
    assert.equal(e.color, "tomato");
    assert.ok(e.myColor, "marked as my own pick");
  }
  for (const { e } of of(await range(bob, "2031-03-01", "2031-03-25"), sid)) assert.equal(e.color, DEFAULT_COLOR.reminder, "bob's view unchanged");
  assert.equal(await setMyColor(await actor(alice), s.companyId, sid, ""), null);
  for (const { e } of of(await range(alice, "2031-03-01", "2031-03-25"), sid)) {
    assert.equal(e.color, DEFAULT_COLOR.reminder, "reset to the default");
    assert.ok(!e.myColor, "no personal colour left");
  }
});

test("L3: with no colour picked, reminders and tasks each have their own default", async () => {
  const rem = await make(alice, { title: "L3 reminder", sendAtLocal: "2031-03-03T09:00", userIds: [alice] });
  const task = await make(alice, { title: "L3 task", sendAtLocal: "2031-03-03T10:00", userIds: [alice] }, { isTask: true, dueAfterMinutes: 60 });
  const r = await range(alice, "2031-03-03", "2031-03-04");
  assert.notEqual(DEFAULT_COLOR.reminder, DEFAULT_COLOR.task);
  assert.equal(one(r, rem).color, DEFAULT_COLOR.reminder);
  assert.equal(one(r, task).color, DEFAULT_COLOR.task);
  assert.equal(one(r, task).isTask, true);
});

test("L4: anyone who can open the reminder may pick a colour for themselves; others are refused", async () => {
  const id = await make(alice, { title: "L4", sendAtLocal: "2031-03-03T09:00", userIds: [alice], shareDepartmentIds: [ops] });
  assert.equal(await setMyColor(await actor(bob), s.companyId, id, "peacock"), null, "bob can open it (shared), cannot change it");
  assert.ok(await setMyColor(await actor(carol), s.companyId, id, "peacock"), "carol can't open it");
  assert.ok(await setMyColor(await actor(blindEditor), s.companyId, id, "peacock"), "an editor who can't see it");
  const rows = await q("select user_id, color from reminder_colors where reminder_id = $1", [id]);
  assert.deepEqual(rows.map((x) => [x.user_id, x.color]), [[bob, "peacock"]]);
});

test.skip("L5: only calendar entries are coloured (browser: other screens and emails)");
