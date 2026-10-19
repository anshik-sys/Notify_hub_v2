// Behaviour tests for docs/expected-behaviour.md section 4 (T1–T10, change
// only the next occurrence), written from the spec, not the code.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { ownerDb } from "@/worker/db";
import { dispatchDue } from "@/worker/delivery";
import { checkFile } from "./attachments";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import {
  cancelReminder,
  createReminder,
  decideReminder,
  deleteReminder,
  detachOccurrence,
  getReminder,
  listAttachments,
  pauseReminder,
  type RawReminder,
  skipNextOccurrence,
  validateInput,
} from "./reminders";
import { seeder } from "./test-helpers";
import { toLocalInput } from "./time";

const s = seeder();
const w = seeder(); // a company of its own for the worker run (T3)
let admin: string, alice: string, bob: string, carol: string, editor: string;
let ops: string, sales: string;
const TZ = "UTC";
// Tomorrow (UTC): at least an hour ahead whatever the time now, so a live worker leaves these alone.
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const tomorrow = day(1);
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const actor = async (companyId: string, id: string) => ({ id, access: await loadAccess(companyId, id) });
const as = (id: string) => actor(s.companyId, id);

const NO_REPEAT = { repeat: "none", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" };
const DAILY = { ...NO_REPEAT, repeat: "daily" };
const raw = (over: Partial<RawReminder> = {}): RawReminder => ({
  title: "Standup",
  description: "Series text",
  senderName: "",
  linkLabels: [],
  linkUrls: [],
  company: false,
  departmentIds: [],
  groupIds: [],
  userIds: [],
  emails: "",
  when: "later",
  sendAtLocal: `${tomorrow}T09:00`,
  repeat: DAILY,
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
const input = (over: Partial<RawReminder> = {}) => {
  const r = validateInput(raw(over), TZ, "A");
  assert.ok("input" in r && r.input, `valid input: ${JSON.stringify(r)}`);
  return r.input;
};
// The edited one-off: tomorrow 10:00, new title and text.
const copyInput = (over: Partial<RawReminder> = {}) =>
  input({ title: "Standup (moved)", description: "Only this time", sendAtLocal: `${tomorrow}T10:00`, repeat: NO_REPEAT, ...over });
const file = (name: string, text: string) => {
  const r = checkFile(name, new TextEncoder().encode(text));
  assert.ok("file" in r);
  return r.file;
};
const makeSeries = async (by: string, over: Partial<RawReminder> = {}, files: ReturnType<typeof file>[] = []) => {
  const r = await createReminder(await as(by), s.companyId, input(over), files);
  assert.ok("id" in r, JSON.stringify(r));
  return r.id;
};
const detach = async (by: string, seriesId: string, inp = copyInput(), files: ReturnType<typeof file>[] = [], remove: string[] = []) =>
  detachOccurrence(await as(by), s.companyId, seriesId, inp, files, remove);
const reminderCount = async () => (await q("select count(*)::int as n from reminders where company_id = $1", [s.companyId]))[0].n as number;
const occurrences = async (id: string) =>
  (await q("select occurs_at, status from reminder_occurrences where reminder_id = $1 order by occurs_at", [id])).map((o) => [
    (o.occurs_at as Date).toISOString(),
    o.status as string,
  ]);
const approvalsFor = async (reminderId: string) =>
  (await q("select user_id from notifications where reminder_id = $1 and kind = 'approval'", [reminderId])).map((x) => x.user_id as string);

before(async () => {
  await s.company();
  await w.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  alice = await s.user({ roles: [MEMBER_ROLE_ID] });
  bob = await s.user({ roles: [MEMBER_ROLE_ID] });
  carol = await s.user({ roles: [MEMBER_ROLE_ID] });
  const [{ id: editors }] = await q("insert into roles (company_id, name, permissions) values ($1, 'Editors', '{reminders.edit,reminders.view_all}') returning id", [
    s.companyId,
  ]);
  editor = await s.user({ roles: [MEMBER_ROLE_ID, editors] });
  const dept = async (name: string, members: [string, boolean][]) => {
    const [{ id }] = await q("insert into departments (company_id, name) values ($1, $2) returning id", [s.companyId, name]);
    for (const [u, mgr] of members) await q("insert into department_members values ($1, $2, $3, $4)", [s.companyId, id, u, mgr]);
    return id as string;
  };
  ops = await dept("Ops", [
    [alice, false],
    [bob, true],
  ]);
  sales = await dept("Sales", [[carol, false]]);
});
after(async () => {
  await w.cleanup();
  await s.cleanup();
  await ownerDb.$client.end();
  await db.$client.end();
});

test("T1: an admin's 'only the next one' makes a scheduled one-time copy, created by the series' creator", async () => {
  const series = await makeSeries(alice, { departmentIds: [ops] });
  const res = await detach(admin, series, copyInput({ departmentIds: [ops] }));
  assert.ok("id" in res, JSON.stringify(res));
  assert.notEqual(res.id, series);
  const c = (await getReminder(s.companyId, res.id))!;
  assert.ok(c, "copy exists");
  assert.equal(c.title, "Standup (moved)");
  assert.equal(c.description, "Only this time");
  assert.equal(c.recurrence, null, "one-time");
  assert.equal(toLocalInput(c.sendAt, TZ), `${tomorrow}T10:00`, "at the chosen time");
  assert.equal(c.status, "scheduled");
  assert.equal(c.createdBy, alice, "creator is the series' original creator, not the admin");
});

test("T2: the series skips that date, moves to the following one, its content unchanged", async () => {
  const series = await makeSeries(alice, { departmentIds: [ops] });
  const before = (await getReminder(s.companyId, series))!;
  const res = await detach(alice, series, copyInput({ departmentIds: [ops] }));
  assert.ok("id" in res, JSON.stringify(res));
  const after = (await getReminder(s.companyId, series))!;
  assert.deepEqual(await occurrences(series), [[before.sendAt.toISOString(), "skipped"]], "that date recorded as skipped");
  assert.equal(after.sendAt.toISOString(), new Date(before.sendAt.getTime() + 86_400_000).toISOString(), "next = the following occurrence");
  assert.equal(after.status, "scheduled");
  assert.deepEqual(
    [after.title, after.description, after.recurrence, after.anchorLocal, after.targets.map((t) => [t.kind, t.ref])],
    [before.title, before.description, before.recurrence, before.anchorLocal, before.targets.map((t) => [t.kind, t.ref])],
    "series content unchanged",
  );
});

test("T3: the worker past that date: the series sends nothing for it; the copy sends once", async () => {
  // Own company, so the dispatch only sees these two reminders.
  const wAdmin = await w.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  const wActor = await actor(w.companyId, wAdmin);
  const made = await createReminder(wActor, w.companyId, input({ userIds: [wAdmin] }));
  assert.ok("id" in made);
  const firstAt = (await getReminder(w.companyId, made.id))!.sendAt;
  const copy = await detachOccurrence(wActor, w.companyId, made.id, copyInput({ userIds: [wAdmin] }));
  assert.ok("id" in copy, JSON.stringify(copy));

  const enqueued: string[] = [];
  const enqueue = async (ids: string[]) => void enqueued.push(...ids);
  const pastIt = new Date(`${tomorrow}T10:00:30Z`); // past both 09:00 (series date) and 10:00 (copy)
  await dispatchDue(enqueue, w.companyId, pastIt);
  await dispatchDue(enqueue, w.companyId, pastIt); // a second tick sends nothing more

  const wq = async (sql: string, params: unknown[]) => (await w.owner.query(sql, params)).rows;
  const seriesOcc = await wq("select occurs_at, status from reminder_occurrences where reminder_id = $1", [made.id]);
  assert.deepEqual(
    seriesOcc.map((o) => [o.occurs_at.toISOString(), o.status]),
    [[firstAt.toISOString(), "skipped"]],
    "series: only the skipped record for that date",
  );
  assert.equal((await wq("select 1 from deliveries where reminder_id = $1", [made.id])).length, 0, "series delivered nothing");
  const copyOcc = await wq("select status from reminder_occurrences where reminder_id = $1", [copy.id]);
  assert.equal(copyOcc.length, 1, "copy: one occurrence");
  assert.equal((await wq("select 1 from deliveries where reminder_id = $1", [copy.id])).length, 1, "copy: one delivery");
  assert.equal(enqueued.length, 1, "one send enqueued in total");
});

test("T4: attachments: kept ones copied, removed ones stay on the series, new uploads on the copy only", async () => {
  const series = await makeSeries(alice, { departmentIds: [ops] }, [file("keep.txt", "keep"), file("drop.txt", "drop")]);
  const files = await listAttachments(s.companyId, series);
  const drop = files.find((f) => f.fileName === "drop.txt")!;
  const res = await detach(alice, series, copyInput({ departmentIds: [ops] }), [file("new.txt", "fresh")], [drop.id]);
  assert.ok("id" in res, JSON.stringify(res));

  const onCopy = await listAttachments(s.companyId, res.id);
  assert.deepEqual(onCopy.map((f) => f.fileName).sort(), ["keep.txt", "new.txt"]);
  assert.deepEqual((await listAttachments(s.companyId, series)).map((f) => f.fileName).sort(), ["drop.txt", "keep.txt"], "series files untouched");
  // The copy has its own rows and bytes; the removed one's bytes are still on the series.
  const keepCopy = onCopy.find((f) => f.fileName === "keep.txt")!;
  assert.ok(!files.some((f) => f.id === keepCopy.id), "a separate attachment row");
  const blob = async (id: string) => (await q("select data from attachment_blobs where attachment_id = $1", [id]))[0]?.data?.toString();
  assert.equal(await blob(keepCopy.id), "keep");
  assert.equal(await blob(drop.id), "drop");
});

test("T5: refused for a paused, pending, cancelled or deleted series and for a one-time reminder", async () => {
  const paused = await makeSeries(alice, { departmentIds: [ops] });
  assert.equal(await pauseReminder(await as(alice), s.companyId, paused), null);
  const pending = await makeSeries(alice, { departmentIds: [sales] });
  assert.equal((await getReminder(s.companyId, pending))!.status, "pending_approval");
  const cancelled = await makeSeries(alice, { departmentIds: [ops] });
  assert.equal(await cancelReminder(await as(alice), s.companyId, cancelled), null);
  const deleted = await makeSeries(alice, { departmentIds: [ops] });
  assert.equal(await deleteReminder(await as(alice), s.companyId, deleted), null);
  const once = await makeSeries(alice, { departmentIds: [ops], repeat: NO_REPEAT });

  for (const [label, id] of Object.entries({ paused, pending, cancelled, deleted, once })) {
    const before = await q("select status, send_at from reminders where id = $1", [id]);
    const count = await reminderCount();
    const res = await detach(admin, id, copyInput({ departmentIds: [ops] }));
    assert.ok("error" in res, `${label}: refused`);
    assert.equal(await reminderCount(), count, `${label}: no copy made`);
    assert.deepEqual(await q("select status, send_at from reminders where id = $1", [id]), before, `${label}: unchanged`);
    assert.deepEqual(await occurrences(id), [], `${label}: nothing skipped`);
  }
});

test("T6: a member who can't change the series is refused ('not found')", async () => {
  const series = await makeSeries(alice, { departmentIds: [ops] });
  const before = (await getReminder(s.companyId, series))!;
  const count = await reminderCount();
  const res = await detach(carol, series, copyInput({ userIds: [carol] }));
  assert.ok("error" in res);
  assert.match(res.error, /not found/i);
  assert.equal(await reminderCount(), count);
  assert.equal((await getReminder(s.companyId, series))!.sendAt.getTime(), before.sendAt.getTime());
  assert.deepEqual(await occurrences(series), []);
});

test("T7a: a copy with recipients outside the creator's scope needs approval; approvers notified", async () => {
  const series = await makeSeries(alice, { departmentIds: [ops] });
  assert.equal((await getReminder(s.companyId, series))!.status, "scheduled");
  const res = await detach(alice, series, copyInput({ departmentIds: [sales] }));
  assert.ok("id" in res, JSON.stringify(res));
  assert.equal((await getReminder(s.companyId, res.id))!.status, "pending_approval");
  assert.ok((await approvalsFor(res.id)).includes(admin), "the approver (admin) is notified");
});

test("T7b: the series was approved for those recipients: the copy is scheduled, no new approval", async () => {
  const series = await makeSeries(alice, { departmentIds: [sales] });
  assert.equal(await decideReminder(await as(admin), s.companyId, series, true), null);
  assert.equal((await getReminder(s.companyId, series))!.status, "scheduled");
  const res = await detach(alice, series, copyInput({ departmentIds: [sales] }));
  assert.ok("id" in res, JSON.stringify(res));
  assert.equal((await getReminder(s.companyId, res.id))!.status, "scheduled");
  assert.deepEqual(await approvalsFor(res.id), [], "no approval request for the copy");
});

test("T7c: a copy adding a NEW out-of-scope recipient needs approval", async () => {
  const series = await makeSeries(alice, { departmentIds: [sales] });
  assert.equal(await decideReminder(await as(admin), s.companyId, series, true), null);
  const res = await detach(alice, series, copyInput({ departmentIds: [sales], emails: "ext@else.test" }));
  assert.ok("id" in res, JSON.stringify(res));
  assert.equal((await getReminder(s.companyId, res.id))!.status, "pending_approval");
  assert.ok((await approvalsFor(res.id)).includes(admin));
});

test("T8: an editor without approve sending an admin's series' copy to the whole company needs approval", async () => {
  const series = await makeSeries(admin, { userIds: [alice] });
  assert.equal((await getReminder(s.companyId, series))!.status, "scheduled");
  const res = await detach(editor, series, copyInput({ company: true }));
  assert.ok("id" in res, JSON.stringify(res));
  const c = (await getReminder(s.companyId, res.id))!;
  assert.equal(c.createdBy, admin);
  assert.equal(c.status, "pending_approval");
});

test("T9: when the next occurrence was the series' last, the series ends after the copy", async () => {
  // Every day, 2 times ("custom" carries the end): skip the first, so the next one is the last.
  const series = await makeSeries(alice, { departmentIds: [ops], repeat: { ...DAILY, repeat: "custom", ends: "count", count: "2" } });
  assert.equal(await skipNextOccurrence(await as(alice), s.companyId, series), null);
  const r = (await getReminder(s.companyId, series))!;
  assert.equal(r.status, "scheduled");
  assert.deepEqual(r.recurrence?.end, { type: "count", count: 2 });
  const res = await detach(alice, series, copyInput({ departmentIds: [ops], sendAtLocal: `${day(2)}T10:00` }));
  assert.ok("id" in res, JSON.stringify(res));
  const after = (await getReminder(s.companyId, series))!;
  assert.ok(!["scheduled", "paused", "pending_approval"].includes(after.status), `series ended (status ${after.status})`);
  assert.equal((await getReminder(s.companyId, res.id))!.status, "scheduled");
});

test("T10: an input with a repeat rule is refused", async () => {
  const series = await makeSeries(alice, { departmentIds: [ops] });
  const before = (await getReminder(s.companyId, series))!;
  const count = await reminderCount();
  const res = await detach(alice, series, input({ title: "Still repeating", departmentIds: [ops], sendAtLocal: `${tomorrow}T10:00` }));
  assert.ok("error" in res, "refused");
  assert.equal(await reminderCount(), count);
  assert.equal((await getReminder(s.companyId, series))!.sendAt.getTime(), before.sendAt.getTime());
  assert.deepEqual(await occurrences(series), []);
});
