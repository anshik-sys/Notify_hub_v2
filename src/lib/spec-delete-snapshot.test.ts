// Behaviour tests from docs/expected-behaviour.md, sections 1 (D1–D13, delete a
// reminder) and 2 (S1–S5, what each send said). The spec is the source of truth.
//
// Two companies: `s` for the web-side cases, `w` for anything that runs the
// worker (dispatchDue with a far-future "now" would otherwise pick up every
// scheduled reminder in `s`). Worker dates are in 2042–2044 so a live worker
// never sees them as due or overdue.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { ownerDb } from "@/worker/db";
import { claimFollowUps, deliverOne, dispatchDue, followUpOne } from "@/worker/delivery";
import { purgeCompany } from "@/worker/retention";
import { authDb } from "./auth";
import { addComment } from "./comments";
import { listNotifications, unreadCount } from "./notifications";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { parseReportFilters, overdueTasks, taskCompletion } from "./reports";
import { cancelReminder, deleteReminder, deliveryLog, getReminder, reminderAccess, updateReminder, type ReminderInput } from "./reminders";
import { sendNow, sendTest } from "./send-now";
import { myDoneTasks, myOpenTasks } from "./tasks";
import { seeder } from "./test-helpers";
import { calendarMonth, parseFilters, searchReminders, upcoming } from "./views";

const s = seeder();
const w = seeder();
type Seeder = ReturnType<typeof seeder>;

let admin: string, alice: string, bob: string, carol: string, dave: string, editor: string, blindEditor: string, sharedDept: string;
let wCreator: string, wAlice: string;

const shortId = () => `R-${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const actorIn = (co: Seeder) => async (id: string) => ({ id, name: `N-${id.slice(0, 6)}`, email: `${id}@${co.domain}`, access: await loadAccess(co.companyId, id) });
const actor = actorIn(s);
const wActor = actorIn(w);
const qIn = (co: Seeder) => async (sql: string, params: unknown[] = []) => (await co.owner.query(sql, params)).rows;
const q = qIn(s);
const wq = qIn(w);
const capture = () => {
  const subjects: string[] = [];
  const send = (async (m: { subject: string }) => void subjects.push(m.subject)) as never;
  return { subjects, send };
};

type Mk = {
  co?: Seeder;
  createdBy?: string;
  status?: string;
  title?: string;
  description?: string;
  links?: { label: string; url: string }[];
  senderName?: string;
  sendAt?: string; // ISO; default two hours ahead
  recurrence?: object | null;
  isTask?: boolean;
};
const mk = async (o: Mk = {}) => {
  const co = o.co ?? s;
  const sendAt = o.sendAt ?? new Date(Date.now() + 2 * 3_600_000).toISOString();
  const [{ id }] = await qIn(co)(
    `insert into reminders (company_id, short_id, created_by, title, description, links, sender_name, send_at, status, time_zone, anchor_local, recurrence, is_task, due_after_minutes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'UTC', $10, $11, $12, $13) returning id`,
    [
      co.companyId,
      shortId(),
      o.createdBy ?? alice,
      o.title ?? `Spec ${randomUUID().slice(0, 8)}`,
      o.description ?? "",
      JSON.stringify(o.links ?? []),
      o.senderName ?? "S",
      sendAt,
      o.status ?? "scheduled",
      sendAt.slice(0, 16),
      o.recurrence ? JSON.stringify(o.recurrence) : null,
      o.isTask ?? false,
      o.isTask ? 60 : null,
    ],
  );
  return id as string;
};
const target = (co: Seeder, reminderId: string, userId: string) =>
  qIn(co)("insert into reminder_targets values ($1, $2, 'user', $3)", [reminderId, co.companyId, userId]);
const occurrence = async (co: Seeder, reminderId: string, at: string, status = "sent", dueAt: string | null = null) =>
  (await qIn(co)("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, due_at) values ($1, $2, $3, $4, $5) returning id", [co.companyId, reminderId, at, status, dueAt]))[0]
    .id as string;
const delivery = async (co: Seeder, reminderId: string, occ: string, userId: string | null, status = "sent") =>
  (
    await qIn(co)(
      "insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id, status) values ($1, $2, $3, $4, $5, $6) returning id",
      [co.companyId, reminderId, occ, userId ? `${userId}@${co.domain}` : `ext-${randomUUID().slice(0, 6)}@example.test`, userId, status],
    )
  )[0].id as string;
const assign = async (co: Seeder, reminderId: string, occ: string, userId: string, doneAt: string | null = null) =>
  (
    await qIn(co)("insert into task_assignments (company_id, reminder_id, occurrence_id, user_id, done_at) values ($1, $2, $3, $4, $5) returning id", [
      co.companyId,
      reminderId,
      occ,
      userId,
      doneAt,
    ])
  )[0].id as string;
const has = (v: unknown, id: string) => JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x.entries()] : x)).includes(id);
const isDeleted = async (id: string) => (await q("select deleted_at is not null as d from reminders where id = $1", [id]))[0]?.d as boolean;

before(async () => {
  await s.company();
  await w.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [alice, bob, carol, dave] = [await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] })];
  const [{ id: editors }] = await q("insert into roles (company_id, name, permissions) values ($1, 'Editors', '{reminders.edit,reminders.view_all}') returning id", [s.companyId]);
  const [{ id: blind }] = await q("insert into roles (company_id, name, permissions) values ($1, 'Blind editors', '{reminders.edit}') returning id", [s.companyId]);
  editor = await s.user({ roles: [MEMBER_ROLE_ID, editors] });
  blindEditor = await s.user({ roles: [MEMBER_ROLE_ID, blind] });
  [{ id: sharedDept }] = await q("insert into departments (company_id, name) values ($1, 'Shared') returning id", [s.companyId]);
  await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, sharedDept, dave]);

  await wq("update companies set follow_up_time = '09:00' where id = $1", [w.companyId]);
  wCreator = await w.user({ roles: [MEMBER_ROLE_ID] });
  wAlice = await w.user({ roles: [MEMBER_ROLE_ID] });
});
after(async () => {
  await s.cleanup();
  await w.cleanup();
  await db.$client.end();
  await ownerDb.$client.end();
  await authDb.$client.end();
});

// --- 1. Delete a reminder ------------------------------------------------------

test("D1: the creator may delete their own reminder in every status", async () => {
  for (const status of ["scheduled", "paused", "sent", "cancelled", "rejected", "pending_approval"]) {
    const id = await mk({ status });
    assert.equal(await deleteReminder(await actor(alice), s.companyId, id), null, status);
    assert.equal(await isDeleted(id), true, status);
  }
});

test("D2a: an editor with reminders.view_all may delete someone else's", async () => {
  const id = await mk();
  assert.equal(await deleteReminder(await actor(editor), s.companyId, id), null);
  assert.equal(await isDeleted(id), true);
});

test("D2b: a non-creator member, a recipient and an editor who can't see it are refused (not found)", async () => {
  const id = await mk();
  await target(s, id, bob);
  const occ = await occurrence(s, id, new Date(Date.now() - 86_400_000).toISOString());
  await delivery(s, id, occ, bob);
  assert.equal(await reminderAccess(s.companyId, await actor(bob), { id, createdBy: alice }), "viewer"); // bob really is a recipient
  for (const [who, label] of [
    [carol, "member"],
    [bob, "recipient"],
    [blindEditor, "editor without view_all"],
  ]) {
    assert.match((await deleteReminder(await actor(who), s.companyId, id)) ?? "", /not found/i, label);
  }
  assert.equal(await isDeleted(id), false);
});

test("D3: hidden from open, lists, search, calendar and upcoming for creator, admin, recipient and shared-with", async () => {
  const title = `D3 ${randomUUID().slice(0, 8)}`;
  const sendAt = new Date(Date.now() + 2 * 3_600_000);
  const id = await mk({ title, sendAt: sendAt.toISOString(), recurrence: { freq: "daily", interval: 1, end: { type: "never" } } });
  await target(s, id, bob);
  await q("insert into reminder_shares (reminder_id, company_id, kind, ref) values ($1, $2, 'department', $3)", [id, s.companyId, sharedDept]);
  const occ = await occurrence(s, id, new Date(Date.now() - 86_400_000).toISOString());
  await delivery(s, id, occ, bob);
  const month = sendAt.toISOString().slice(0, 7);
  const views = async (who: string) => {
    const a = await actor(who);
    return {
      search: has((await searchReminders(s.companyId, a, "UTC", parseFilters({ q: title }))).rows, id),
      all: has((await searchReminders(s.companyId, a, "UTC", parseFilters({}))).rows, id),
      calendar: has(await calendarMonth(s.companyId, a, "UTC", month), id),
      upcoming: has(await upcoming(s.companyId, a, 500), id),
    };
  };
  // Before: every viewer can find it (upcoming is only for those who oversee it).
  for (const who of [alice, admin, bob, dave]) {
    const v = await views(who);
    assert.ok(await reminderAccess(s.companyId, await actor(who), { id, createdBy: alice }), `can open before delete: ${who}`);
    assert.ok(v.search && v.calendar, `visible before delete: ${who}`);
  }
  assert.ok((await views(alice)).upcoming && (await views(admin)).upcoming);

  assert.equal(await deleteReminder(await actor(alice), s.companyId, id), null);
  // Opening it: the page loads it with getReminder (reminderAccess takes an
  // already-loaded row, so it isn't the gate for a deleted one).
  assert.equal(await getReminder(s.companyId, id), null);
  for (const [who, label] of [
    [alice, "creator"],
    [admin, "admin"],
    [bob, "recipient"],
    [dave, "shared with"],
  ]) {
    assert.deepEqual(await views(who), { search: false, all: false, calendar: false, upcoming: false }, label);
  }
});

test("D4: after delete, comments (read and post), send me a test, send now, edit and cancel are refused", async () => {
  const id = await mk({ title: "D4 deleted" });
  await target(s, id, bob);
  const a = await actor(alice);
  assert.equal(await deleteReminder(a, s.companyId, id), null);

  // Reading the thread: listComments takes no viewer; the page only shows it
  // for a reminder getReminder can load.
  assert.equal(await getReminder(s.companyId, id), null);

  const mail = capture();
  const posted = await addComment(a, s.companyId, id, { body: "still here?", mentionIds: [] }, { send: mail.send });
  assert.ok("error" in posted, "post comment refused");
  assert.equal((await q("select 1 from comments where reminder_id = $1", [id])).length, 0);

  const test = await sendTest(a, s.companyId, id, { send: mail.send });
  assert.ok("error" in test && test.error, "send me a test refused");
  assert.deepEqual(mail.subjects, []);

  assert.ok((await sendNow(a, s.companyId, id)).error, "send now refused");

  const input: ReminderInput = {
    title: "D4 edited",
    description: "",
    links: [],
    senderName: "S",
    sendAt: new Date(Date.now() + 3 * 3_600_000),
    recurrence: null,
    anchorLocal: "2026-01-01T00:00",
    timeZone: "UTC",
    isTask: false,
    dueAfterMinutes: null,
    channels: ["email"],
    tags: [],
    targets: [{ kind: "user", ref: bob }],
    shares: [],
  };
  assert.ok(await updateReminder(a, s.companyId, id, input), "edit refused");
  assert.ok(await cancelReminder(a, s.companyId, id), "cancel refused");
  const [row] = await q("select title, send_now_at from reminders where id = $1", [id]);
  assert.deepEqual(row, { title: "D4 deleted", send_now_at: null });
});

test("D5: a deleted one-time reminder reaching its send time, and a deleted series reaching its next date, send nothing", async () => {
  const once = await mk({ co: w, createdBy: wCreator, sendAt: "2044-02-01T09:00:00.000Z" });
  await target(w, once, wAlice);
  const series = await mk({ co: w, createdBy: wCreator, sendAt: "2044-02-01T09:00:00.000Z", recurrence: { freq: "daily", interval: 1, end: { type: "never" } } });
  await target(w, series, wAlice);
  const enqueued: string[] = [];
  const enqueue = async (ids: string[]) => void enqueued.push(...ids);
  const mail = capture();

  // The series sends its first date normally (control), then is deleted.
  assert.equal(await deleteReminder(await wActor(wCreator), w.companyId, once), null);
  await dispatchDue(enqueue, w.companyId, new Date("2044-02-01T09:00:30Z"));
  for (const d of enqueued) await deliverOne(d, mail.send);
  const seriesFirst = (await wq("select count(*)::int as n from deliveries where reminder_id = $1", [series]))[0].n;
  assert.equal(seriesFirst, 1, "control: the live series sent its first date");
  assert.equal(await deleteReminder(await wActor(wCreator), w.companyId, series), null);

  await dispatchDue(enqueue, w.companyId, new Date("2044-02-02T09:00:30Z"));
  await dispatchDue(enqueue, w.companyId, new Date("2044-02-05T09:00:30Z"));
  for (const d of enqueued.slice(1)) await deliverOne(d, mail.send);

  assert.equal((await wq("select 1 from reminder_occurrences where reminder_id = $1", [once])).length, 0, "one-time: no occurrence");
  assert.equal((await wq("select 1 from deliveries where reminder_id = $1", [once])).length, 0, "one-time: no delivery");
  assert.deepEqual(
    (await wq("select occurs_at from reminder_occurrences where reminder_id = $1 and status in ('sending','sent')", [series])).map((o) => o.occurs_at.toISOString()),
    ["2044-02-01T09:00:00.000Z"],
    "series: nothing after the delete",
  );
  assert.equal((await wq("select count(*)::int as n from deliveries where reminder_id = $1", [series]))[0].n, 1);
  assert.equal(mail.subjects.length, 1);
  await wq("update reminders set status = 'cancelled' where id = any($1)", [[once, series]]); // keep later dispatches clean
});

test("D6: daily follow-ups for an overdue task stop once it's deleted", async () => {
  const id = await mk({ co: w, createdBy: wCreator, status: "sent", isTask: true, sendAt: "2042-05-01T08:00:00.000Z" });
  await target(w, id, wAlice);
  const occ = await occurrence(w, id, "2042-05-01T08:00:00Z", "sent", "2042-05-01T09:00:00Z");
  await delivery(w, id, occ, wAlice);
  const a = await assign(w, id, occ, wAlice);

  // Control: overdue and not done, so it's claimed for a follow-up the next morning.
  assert.ok((await claimFollowUps(new Date("2042-05-02T09:00:00Z"), w.companyId)).includes(a), "control: follow-up claimed before delete");

  assert.equal(await deleteReminder(await wActor(wCreator), w.companyId, id), null);
  const mail = capture();
  await followUpOne(a, mail.send);
  assert.deepEqual(mail.subjects, [], "the follow-up claimed before the delete isn't sent after it");
  assert.ok(!(await claimFollowUps(new Date("2042-05-03T09:00:00Z"), w.companyId)).includes(a), "no follow-up the day after");
  assert.ok(!(await claimFollowUps(new Date("2042-05-04T09:00:00Z"), w.companyId)).includes(a), "nor the day after that");
});

test("D7: the assignee no longer sees the task in My tasks (open or done)", async () => {
  const id = await mk({ status: "sent", isTask: true, sendAt: "2042-01-08T09:00:00.000Z" });
  await target(s, id, bob);
  const open = await occurrence(s, id, "2042-01-08T09:00:00Z", "sent", "2042-01-08T10:00:00Z");
  const done = await occurrence(s, id, "2042-01-01T09:00:00Z", "sent", "2042-01-01T10:00:00Z");
  await delivery(s, id, open, bob);
  await delivery(s, id, done, bob);
  await assign(s, id, open, bob);
  await assign(s, id, done, bob, "2042-01-01T09:30:00Z");
  assert.ok(has(await myOpenTasks(s.companyId, bob, 500), id), "control: open");
  assert.ok(has(await myDoneTasks(s.companyId, bob, 500), id), "control: done");

  assert.equal(await deleteReminder(await actor(alice), s.companyId, id), null);
  assert.equal(has(await myOpenTasks(s.companyId, bob, 500), id), false, "open tab");
  assert.equal(has(await myDoneTasks(s.companyId, bob, 500), id), false, "done tab");
});

test("D8: notifications about it are gone from the list and the unread count drops", async () => {
  const id = await mk();
  const other = await mk();
  await q("insert into notifications (company_id, user_id, kind, reminder_id, text) values ($1, $2, 'reminder', $3, 'about it'), ($1, $2, 'reminder', $4, 'other')", [
    s.companyId,
    carol,
    id,
    other,
  ]);
  const before = await unreadCount(s.companyId, carol);
  assert.ok(has(await listNotifications(s.companyId, carol), id), "control: listed");

  assert.equal(await deleteReminder(await actor(alice), s.companyId, id), null);
  assert.equal(has(await listNotifications(s.companyId, carol), id), false);
  assert.ok(has(await listNotifications(s.companyId, carol), other), "other notifications stay");
  assert.equal(await unreadCount(s.companyId, carol), before - 1);
});

test("D9: refused while deliveries are queued or sending; allowed once they're sent or failed", async () => {
  const id = await mk({ status: "sending" });
  const occ = await occurrence(s, id, new Date().toISOString(), "sending");
  const d1 = await delivery(s, id, occ, null, "queued");
  await delivery(s, id, occ, null, "sent");
  const a = await actor(alice);
  assert.match((await deleteReminder(a, s.companyId, id)) ?? "", /being sent/, "queued");
  await q("update deliveries set status = 'sending' where id = $1", [d1]);
  assert.match((await deleteReminder(a, s.companyId, id)) ?? "", /being sent/, "sending");
  assert.equal(await isDeleted(id), false);
  await q("update deliveries set status = 'failed' where id = $1", [d1]);
  assert.equal(await deleteReminder(a, s.companyId, id), null);
  assert.equal(await isDeleted(id), true);
});

test("D10: deleting it again is refused (not found)", async () => {
  const id = await mk();
  assert.equal(await deleteReminder(await actor(alice), s.companyId, id), null);
  assert.match((await deleteReminder(await actor(alice), s.companyId, id)) ?? "", /not found/i);
  assert.match((await deleteReminder(await actor(admin), s.companyId, id)) ?? "", /not found/i);
});

// The audit log takes its actor from the signed-in request (src/db/index.ts);
// a lib test has no request, so nothing is attributed here. Verified in Chrome
// 2026-10-19: Maya's delete logged "update" by Maya Patel with deleted_at.
test.skip("D11: the audit log has a row for the reminder, attributed to the person who deleted it (needs a signed-in request; checked in the browser)", async () => {
  const id = await mk();
  const [{ max }] = await q("select coalesce(max(id), 0) as max from audit_log where company_id = $1", [s.companyId]);
  assert.equal(await deleteReminder(await actor(admin), s.companyId, id), null);
  const rows = await q("select actor_id, object_type, object_id from audit_log where company_id = $1 and id > $2 and object_id = $3", [s.companyId, max, id]);
  assert.ok(rows.length > 0, "an audit_log row for the deleted reminder");
  assert.ok(rows.some((r) => r.actor_id === admin), `attributed to the deleter, got ${JSON.stringify(rows)}`);
});

test("D12: task reports (completion, overdue) don't count the deleted task", async () => {
  const F = (p: Record<string, string>) => parseReportFilters(p, "UTC", new Date("2030-02-01T00:00Z"));
  const id = await mk({ status: "sent", isTask: true, sendAt: "2030-01-15T09:00:00.000Z" });
  const occ = await occurrence(s, id, "2030-01-15T09:00:00Z", "sent", "2030-01-15T10:00:00Z");
  await assign(s, id, occ, bob);
  await assign(s, id, occ, carol, "2030-01-15T09:30:00Z");
  const completion = async () =>
    (await taskCompletion(s.companyId, "UTC", F({ report: "tasks", from: "2030-01-01", to: "2030-01-31", by: "person" }))).reduce((n, r) => n + Number(r.assigned), 0);
  const overdue = async () => (await overdueTasks(s.companyId, F({ report: "overdue", by: "person" }), new Date("2030-01-20T00:00Z"))).detail.length;
  assert.equal(await completion(), 2, "control: completion counts it");
  assert.equal(await overdue(), 1, "control: overdue counts it");

  assert.equal(await deleteReminder(await actor(alice), s.companyId, id), null);
  assert.equal(await completion(), 0, "completion");
  assert.equal(await overdue(), 0, "overdue");
});

test("D13: once the retention period passes, a deleted reminder is purged with other finished ones", async () => {
  const id = await mk({ title: "D13 deleted" });
  assert.equal(await deleteReminder(await actor(alice), s.companyId, id), null);
  await purgeCompany(s.companyId, 90, new Date(Date.now() + 200 * 86_400_000));
  assert.equal((await q("select 1 from reminders where id = $1", [id])).length, 0);
});

// --- 2. What each send actually said -----------------------------------------------

type Copy = { title: string; description: string; links: { label: string; url: string }[]; senderName: string };
// The recorded copy of a deliveryLog occurrence (its `snapshot`).
const copyOf = (o: Record<string, unknown>): Copy | null => {
  const src = o.snapshot as Record<string, unknown> | null;
  if (!src || typeof src.title !== "string") return null;
  return { title: src.title, description: src.description as string, links: src.links as Copy["links"], senderName: src.senderName as string };
};
type LogOcc = Record<string, unknown> & { id?: string; occursAt?: Date };
const logOccurrences = async (reminderId: string): Promise<LogOcc[]> => {
  // { latest, rows, history }: the latest occurrence plus the last 10.
  const log = (await deliveryLog(w.companyId, reminderId)) as unknown as { latest: LogOcc | null; history: LogOcc[] };
  return [...(log.latest ? [log.latest] : []), ...log.history];
};
const byTime = async (reminderId: string, at: string) => {
  const occs = (await logOccurrences(reminderId)).filter((o) => o.occursAt && new Date(o.occursAt as Date).toISOString() === at);
  assert.ok(occs.length > 0, `deliveryLog lists the occurrence at ${at}`);
  return occs[0];
};
const v1: Copy = { title: "Snap v1", description: "Desc v1", links: [{ label: "Doc", url: "https://a.test/v1" }], senderName: "HR v1" };
const editTo = (id: string, n: number) =>
  wq("update reminders set title = $2, description = $3, links = $4, sender_name = $5 where id = $1", [
    id,
    `Snap v${n}`,
    `Desc v${n}`,
    JSON.stringify([{ label: "Doc", url: `https://a.test/v${n}` }]),
    `HR v${n}`,
  ]);
let s1Id: string;

test("S1: a sent occurrence's log shows the title, description, links and sender as they were", async () => {
  s1Id = await mk({ co: w, createdBy: wCreator, sendAt: "2043-01-01T09:00:00.000Z", ...v1 });
  await target(w, s1Id, wAlice);
  const ids: string[] = [];
  await dispatchDue(async (x) => void ids.push(...x), w.companyId, new Date("2043-01-01T09:00:30Z"));
  assert.equal(ids.length, 1);
  const mail = capture();
  assert.equal(await deliverOne(ids[0], mail.send), "sent");
  assert.match(mail.subjects[0], /Snap v1/);
  assert.deepEqual(copyOf(await byTime(s1Id, "2043-01-01T09:00:00.000Z")), v1);
});

test("S2: after an edit, that occurrence's log still shows the old content", async () => {
  await editTo(s1Id, 2);
  assert.deepEqual(copyOf(await byTime(s1Id, "2043-01-01T09:00:00.000Z")), v1);
});

test("S3: a failed delivery retried after an edit sends the original subject", async () => {
  const id = await mk({ co: w, createdBy: wCreator, sendAt: "2043-02-01T09:00:00.000Z", ...v1 });
  await target(w, id, wAlice);
  const ids: string[] = [];
  await dispatchDue(async (x) => void ids.push(...x), w.companyId, new Date("2043-02-01T09:00:30Z"));
  assert.equal(ids.length, 1);
  await assert.rejects(
    deliverOne(ids[0], (async () => {
      throw new Error("SMTP down");
    }) as never),
    /SMTP down/,
  );
  await editTo(id, 2);
  const mail = capture();
  assert.equal(await deliverOne(ids[0], mail.send), "sent");
  assert.match(mail.subjects[0], /Snap v1/);
  assert.doesNotMatch(mail.subjects[0], /Snap v2/);
});

test("S4: a series edited between two sends: the second has the new content, the first keeps the old", async () => {
  const id = await mk({ co: w, createdBy: wCreator, sendAt: "2043-03-01T09:00:00.000Z", recurrence: { freq: "daily", interval: 1, end: { type: "never" } }, ...v1 });
  await target(w, id, wAlice);
  const mail = capture();
  const run = async (now: string) => {
    const ids: string[] = [];
    await dispatchDue(async (x) => void ids.push(...x), w.companyId, new Date(now));
    assert.equal(ids.length, 1, `one delivery at ${now}`);
    assert.equal(await deliverOne(ids[0], mail.send), "sent");
  };
  await run("2043-03-01T09:00:30Z");
  await editTo(id, 2);
  await run("2043-03-02T09:00:30Z");
  assert.match(mail.subjects[0], /Snap v1/);
  assert.match(mail.subjects[1], /Snap v2/);
  assert.deepEqual(copyOf(await byTime(id, "2043-03-01T09:00:00.000Z")), v1);
  assert.equal(copyOf(await byTime(id, "2043-03-02T09:00:00.000Z"))?.title, "Snap v2");
  assert.equal(copyOf(await byTime(id, "2043-03-02T09:00:00.000Z"))?.senderName, "HR v2");
  await wq("update reminders set status = 'cancelled' where id = $1", [id]);
});

test("S5: missed and skipped occurrences have no recorded copy", async () => {
  const id = await mk({ co: w, createdBy: wCreator, sendAt: "2043-04-01T09:00:00.000Z", recurrence: { freq: "daily", interval: 1, end: { type: "never" } }, ...v1 });
  await target(w, id, wAlice);
  await occurrence(w, id, "2043-04-01T09:00:00Z", "skipped");
  const ids: string[] = [];
  await dispatchDue(async (x) => void ids.push(...x), w.companyId, new Date("2043-04-01T09:00:30Z")); // skipped
  await dispatchDue(async (x) => void ids.push(...x), w.companyId, new Date("2043-04-04T10:00:00Z")); // 2nd, 3rd missed; 4th sent
  const occ = await wq("select occurs_at, status, snapshot from reminder_occurrences where reminder_id = $1 order by occurs_at", [id]);
  assert.deepEqual(
    occ.map((o) => `${o.occurs_at.toISOString().slice(0, 10)} ${o.status}`),
    ["2043-04-01 skipped", "2043-04-02 missed", "2043-04-03 missed", "2043-04-04 sending"],
  );
  for (const o of occ.filter((x) => x.status !== "sending")) assert.equal(o.snapshot, null, `${o.status} ${o.occurs_at.toISOString()}`);
  assert.ok(occ.find((x) => x.status === "sending").snapshot, "control: the sent one has a copy");
  for (const d of ids) await deliverOne(d, capture().send);
  // And the log shows none for them.
  for (const at of ["2043-04-01T09:00:00.000Z", "2043-04-02T09:00:00.000Z"]) {
    const found = (await logOccurrences(id)).filter((o) => o.occursAt && new Date(o.occursAt as Date).toISOString() === at);
    for (const o of found) assert.equal(copyOf(o), null, `log copy for ${at}`);
  }
  await wq("update reminders set status = 'cancelled' where id = $1", [id]);
});
