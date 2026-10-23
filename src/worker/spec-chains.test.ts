// Behaviour tests from docs/expected-behaviour.md section 14, "Chains: start
// when a task is done" (CH1–CH12). Written from the spec, not the code: a
// failure means one of them is wrong.
//
// Entries are made the way the New/Edit form makes them: a post -> formToRaw ->
// validateInput -> createReminder / updateReminder. A chained entry posts
// when=after, after=<task A's id>, and (a task) dueIn + dueUnit instead of due.
// Most are made by olga (a Company Admin, so nothing waits for approval);
// CH8/CH9 use mia, a Member of the Ops department (alice, bob, dave; max is its
// manager; carol is outside it).
//
// Task A is always dated in 2031 and every worker call for it gets an explicit
// `now`, so the live worker on the same database never sends it. When A is
// done, B starts in real time ("at once"), so the live worker may dispatch B
// before this file does: the tests check what exists (occurrences, deliveries),
// not who sent it.
//
// Left for the browser: the wording and link on B's page and in the list, "Then:
// <B>" on A's page and its "Add a next step" button (CH10).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "@/lib/auth";
import { connectGoogle } from "@/lib/google-calendar";
import type { sendMail } from "@/lib/mail";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "@/lib/permissions";
import {
  cancelReminder,
  createReminder,
  decideReminder,
  deleteReminder,
  formToRaw,
  getReminder,
  reminderAccess,
  setOccurrenceDone,
  statusLabel,
  updateReminder,
  validateInput,
  type RawReminder,
} from "@/lib/reminders";
import { sendNow } from "@/lib/send-now";
import { setDone, WAITING_AT } from "@/lib/tasks";
import { seeder } from "@/lib/test-helpers";
import { calendarRange, chainChoices, nextSteps } from "@/lib/views";
import { ownerDb } from "./db";
import { deliverOne, dispatchDue } from "./delivery";
import { syncGoogle } from "./google-sync";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

let olga: string, alice: string, bob: string, carol: string, dave: string, mia: string, max: string;
const emailOf = (id: string) => `${id}@${s.domain}`;
const OUTSIDE = "partner@outside-ch.example";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 86_400_000;
const local = (d: Date) => d.toISOString().slice(0, 16); // company zone is UTC

type Mail = Parameters<typeof sendMail>[0];
const capture = (box: Mail[]) => (async (m: Mail) => void box.push(m)) as unknown as typeof sendMail;
function fakeSlack() {
  return (async (url: string, init: RequestInit) => {
    const json = (b: object) => new Response(JSON.stringify(b));
    const p = init.body as URLSearchParams;
    const method = url.split("/").pop();
    if (method === "users.lookupByEmail") return json({ ok: true, user: { id: `U-${p.get("email")}` } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: `D-${p.get("users")}` } });
    if (method === "chat.postMessage") return json({ ok: true, channel: p.get("channel"), ts: "1.0" });
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
}

// --- Making entries through the form ---------------------------------------------

type Opts = {
  title?: string;
  kind?: "task" | "reminder";
  sendAt?: Date;
  due?: Date;
  users?: string[];
  emails?: string;
  repeat?: string;
  // A chain: wait for this task; a task's due time is dueIn dueUnit after it starts.
  after?: string;
  dueIn?: string;
  dueUnit?: "hours" | "days";
  subs?: { title: string; due: Date; users?: string[] }[];
};
const fields = (o: Opts): [string, string][] => {
  const kind = o.kind ?? "task";
  const chained = o.after !== undefined;
  return [
    ["title", o.title ?? "Step"],
    ["description", "Part of a workflow."],
    ["senderName", ""],
    ...(o.users ?? [dave]).map((u): [string, string] => ["users", u]),
    ["emails", o.emails ?? ""],
    ["when", chained ? "after" : "later"],
    ...(chained ? ([["after", o.after!]] as [string, string][]) : []),
    ["sendAt", o.sendAt ? local(o.sendAt) : ""],
    ["repeat", o.repeat ?? "none"],
    ["every", "1"],
    ["unit", "week"],
    ["monthlyBy", "day"],
    ["ends", "never"],
    ["until", ""],
    ["count", ""],
    ["channels", "email"],
    ["tags", ""],
    ["kind", kind],
    ["due", kind === "task" && !chained && o.due ? local(o.due) : ""],
    ...(kind === "task" && chained
      ? ([
          ["dueIn", o.dueIn ?? "2"],
          ["dueUnit", o.dueUnit ?? "days"],
        ] as [string, string][])
      : []),
    ["remindCustom", ""],
    ["remindUnit", "minutes"],
    ...(o.subs ?? []).flatMap((sub, i): [string, string][] => [
      [`sub.${i}.id`, ""],
      [`sub.${i}.title`, sub.title],
      [`sub.${i}.due`, local(sub.due)],
      ...(sub.users ?? []).map((u): [string, string] => [`sub.${i}.users`, u]),
    ]),
  ];
};
const post = (f: [string, string][]) => {
  const fd = new FormData();
  for (const [k, v] of f) fd.append(k, v);
  return fd;
};
const parse = (o: Opts, tweak?: (raw: RawReminder) => void) => {
  const raw = formToRaw(post(fields(o)));
  tweak?.(raw);
  const r = validateInput(raw, "UTC", "Alerts | Test Co", new Date(), []);
  return "error" in r ? { error: r.error as string, input: undefined } : { error: undefined, input: r.input! };
};
const actor = async (id = olga) => ({ id, email: emailOf(id), access: await loadAccess(s.companyId, id) });
// Saves through the form; returns the id, or the error from the form or the save.
async function attempt(o: Opts, by = olga): Promise<{ id: string; error?: undefined } | { id?: undefined; error: string }> {
  const parsed = parse(o);
  if (parsed.error !== undefined) return { error: `form: ${parsed.error}` };
  const r = await createReminder(await actor(by), s.companyId, parsed.input!);
  if ("error" in r) return { error: `save: ${r.error}` };
  return { id: r.id as string };
}
async function make(o: Opts, by = olga) {
  const r = await attempt(o, by);
  if (r.error !== undefined) throw new Error(`not saved: ${r.error}`);
  return r.id!;
}
async function edit(id: string, o: Opts, by = olga) {
  const parsed = parse(o);
  if (parsed.error !== undefined) return `form: ${parsed.error}`;
  return updateReminder(await actor(by), s.companyId, id, parsed.input!);
}
// A one-time task A (sent at `at`, due a day later).
const taskA = (at: Date, users: string[], o: Partial<Opts> = {}, by = olga) =>
  make({ title: "A", sendAt: at, due: new Date(at.getTime() + DAY), users, ...o }, by);

type Row = { status: string; send_at: Date; after_id: string | null; due_after_minutes: number | null; is_task: boolean; deleted_at: Date | null };
const row = async (id: string) =>
  (await q("select status, send_at, after_id, due_after_minutes, is_task, deleted_at from reminders where id = $1", [id]))[0] as Row;
const occurrences = async (id: string) =>
  (await q("select id, occurs_at, due_at, done_at from reminder_occurrences where reminder_id = $1 order by occurs_at", [id])) as {
    id: string;
    occurs_at: Date;
    due_at: Date | null;
    done_at: Date | null;
  }[];

// --- The worker -----------------------------------------------------------------------

// One worker tick at `now` (2031 dates), delivered at once to a fake mailer.
async function tick(now: Date) {
  const sends: string[] = [];
  await dispatchDue(async (x) => void sends.push(...x), s.companyId, now);
  for (const d of sends) await deliverOne(d, capture([]), fakeSlack());
}
const name = (u: string | null) =>
  u === null ? "outside" : ({ [olga]: "olga", [alice]: "alice", [bob]: "bob", [carol]: "carol", [dave]: "dave", [mia]: "mia", [max]: "max" }[u] ?? u);
// Everyone a reminder's (normal) sends were queued for, sorted.
const sentTo = async (id: string) =>
  ((await q("select user_id, address from deliveries where reminder_id = $1 and kind = 'reminder'", [id])) as { user_id: string | null; address: string }[])
    .map((r) => (r.user_id ? name(r.user_id) : r.address))
    .sort();
const assignment = async (id: string, user: string) => (await q("select id from task_assignments where reminder_id = $1 and user_id = $2", [id, user]))[0]?.id as string;
// Real time: run the worker now until `id` has `want` sends (the live worker may get there first).
async function sentNow(id: string, want: number) {
  for (let i = 0; i < 30; i++) {
    const sends: string[] = [];
    await dispatchDue(async (x) => void sends.push(...x), s.companyId, new Date());
    for (const d of sends) await deliverOne(d, capture([]), fakeSlack());
    if ((await sentTo(id)).length >= want) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  return sentTo(id);
}
// Still waiting: the placeholder send time, no date, nothing sent (after a worker run now).
async function assertWaiting(id: string, why: string) {
  await tick(new Date());
  const r = await row(id);
  assert.equal(r.send_at.getTime(), WAITING_AT.getTime(), `${why}: send_at is the waiting placeholder`);
  assert.deepEqual(await occurrences(id), [], `${why}: no occurrence`);
  assert.deepEqual(await sentTo(id), [], `${why}: nothing sent`);
}
// Marks a task done for one assignee (its only occurrence).
const done = async (taskId: string, user: string, isDone = true) => {
  const a = await assignment(taskId, user);
  assert.ok(a, `${name(user)} is assigned to the task`);
  assert.equal(await setDone(user, s.companyId, a, isDone), null);
};

before(async () => {
  await s.company();
  olga = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [alice, bob, carol, dave, mia, max] = await Promise.all(Array.from({ length: 6 }, () => s.user({ roles: [MEMBER_ROLE_ID] })));
  for (const [id, nm] of [
    [olga, "Olga"],
    [alice, "Alice"],
    [bob, "Bob"],
    [carol, "Carol"],
    [dave, "Dave"],
    [mia, "Mia"],
    [max, "Max"],
  ])
    await q(`update "user" set name = $2 where id = $1`, [id, nm]);
  const [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  for (const [u, mgr] of [
    [mia, false],
    [alice, false],
    [bob, false],
    [dave, false],
    [max, true],
  ] as const)
    await q("insert into department_members values ($1, $2, $3, $4)", [s.companyId, ops, u, mgr]);
});
after(async () => {
  await q("delete from google_calendars where user_id = any($1)", [[olga, alice, bob, carol, dave, mia, max]]);
  await q("delete from deliveries where company_id = $1", [s.companyId]);
  await q("delete from task_assignments where company_id = $1", [s.companyId]);
  await q("delete from reminder_occurrences where company_id = $1", [s.companyId]);
  await q("delete from reminder_covers where company_id = $1", [s.companyId]);
  await q("update reminders set after_id = null where company_id = $1", [s.companyId]);
  await s.cleanup();
  await ownerDb.$client.end();
  await db.$client.end();
  await authDb.$client.end();
});

// --- CH1 -----------------------------------------------------------------------------

test("CH1: 'Start when A is done' saves B as Waiting and sends nothing; no repeat, no event, no sub-tasks; due N hours/days after it starts; Send now sends at once", async (t) => {
  const SEND = new Date("2031-01-06T09:00:00Z");
  const A = await taskA(SEND, [dave]);

  await t.test("a task B: saved as Waiting, waiting for A, nothing sent", async () => {
    const B = await make({ title: "B", after: A, users: [alice], dueIn: "2", dueUnit: "days" });
    const r = await row(B);
    assert.equal(r.after_id, A);
    assert.equal(r.status, "scheduled", "not sent, not cancelled");
    const g = await getReminder(s.companyId, B);
    assert.ok(g);
    assert.equal(g.afterId, A);
    assert.equal(statusLabel(g), "Waiting");
    await assertWaiting(B, "right after saving");
    await tick(SEND); // A goes out; B must not
    await tick(new Date(SEND.getTime() + 2 * DAY));
    assert.deepEqual(await sentTo(A), ["dave"], "control: A was sent");
    assert.deepEqual(await occurrences(B), [], "B has no date while A isn't done");
    assert.deepEqual(await sentTo(B), []);
  });

  await t.test("a reminder B: saved as Waiting too", async () => {
    const B = await make({ title: "B reminder", kind: "reminder", after: A, users: [alice] });
    assert.equal((await row(B)).is_task, false);
    assert.equal((await row(B)).after_id, A);
    assert.equal(statusLabel((await getReminder(s.companyId, B))!), "Waiting");
    await assertWaiting(B, "a waiting reminder");
  });

  await t.test("the due time is 'N hours/days after it starts'", async () => {
    const H = await make({ title: "B hours", after: A, users: [alice], dueIn: "5", dueUnit: "hours" });
    assert.equal((await row(H)).due_after_minutes, 5 * 60);
    const D = await make({ title: "B days", after: A, users: [alice], dueIn: "3", dueUnit: "days" });
    assert.equal((await row(D)).due_after_minutes, 3 * 1440);
  });

  await t.test("it can't repeat", () => {
    const r = parse({ title: "B", after: A, users: [alice], repeat: "weekly" });
    assert.ok(r.error, "a repeating chained task is refused");
    const rr = parse({ title: "B", kind: "reminder", after: A, users: [alice], repeat: "weekly" });
    assert.ok(rr.error, "a repeating chained reminder is refused");
  });

  await t.test("it can't be an event", async () => {
    const r = parse({ title: "B", kind: "reminder", after: A, users: [alice] }, (raw) => {
      raw.isEvent = true;
      raw.isTask = false;
      raw.endLocal = local(new Date(SEND.getTime() + 2 * HOUR));
      raw.allDay = false;
      raw.location = "Room 2";
    });
    if (r.error) return;
    const saved = await createReminder(await actor(), s.companyId, r.input!);
    if ("error" in saved) return;
    const x = await row(saved.id as string);
    assert.ok(!(x.after_id === A && (await getReminder(s.companyId, saved.id as string))?.isEvent), "an event waiting for a task was saved");
  });

  await t.test("a waiting task can't have sub-tasks", async () => {
    const r = parse({ title: "B", after: A, users: [alice], subs: [{ title: "Laptop", due: new Date(SEND.getTime() + 2 * DAY), users: [bob] }] });
    if (r.error) return;
    const saved = await createReminder(await actor(), s.companyId, r.input!);
    if ("error" in saved) return;
    const subs = await q("select id from reminders where parent_id = $1", [saved.id]);
    assert.deepEqual(subs, [], "a waiting task was saved with sub-tasks");
  });

  await t.test("Send now sends it at once, without waiting for A", async () => {
    const B = await make({ title: "B send now", after: A, users: [alice], dueIn: "1", dueUnit: "days" });
    const r = await sendNow(await actor(), s.companyId, B);
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.deepEqual(await sentNow(B, 1), ["alice"]);
    assert.notEqual((await row(B)).send_at.getTime(), WAITING_AT.getTime());
    assert.equal((await occurrences(A))[0]?.done_at ?? null, null, "A still isn't done");
  });
});

// --- CH2 -----------------------------------------------------------------------------

test("CH2: when A is done, B is sent at once; its due time counts from then", async (t) => {
  const SEND = new Date("2031-02-03T09:00:00Z");

  await t.test("a task B, due 2 days after it starts", async () => {
    const A = await taskA(SEND, [dave]);
    const B = await make({ title: "B", after: A, users: [alice], dueIn: "2", dueUnit: "days" });
    await tick(SEND);
    await assertWaiting(B, "A sent, not done");
    const t0 = Date.now();
    await done(A, dave);
    assert.deepEqual(await sentNow(B, 1), ["alice"]);
    const [o] = await occurrences(B);
    assert.ok(o, "B has its occurrence");
    assert.ok(o.occurs_at.getTime() >= t0 - 2000 && o.occurs_at.getTime() <= Date.now(), `sent at once: ${o.occurs_at.toISOString()}`);
    assert.equal(o.due_at?.getTime(), o.occurs_at.getTime() + 2 * DAY, "due 2 days after it starts");
    assert.ok(await assignment(B, alice), "alice has B to do");
  });

  await t.test("a reminder B", async () => {
    const S2 = new Date(SEND.getTime() + 7 * DAY);
    const A = await taskA(S2, [dave]);
    const B = await make({ title: "B reminder", kind: "reminder", after: A, users: [bob] });
    await tick(S2);
    await assertWaiting(B, "A sent, not done");
    await done(A, dave);
    assert.deepEqual(await sentNow(B, 1), ["bob"]);
  });
});

// --- CH3 -----------------------------------------------------------------------------

test("CH3: with several assignees on A, B starts only when all of them are done", async () => {
  const SEND = new Date("2031-03-03T09:00:00Z");
  const A = await taskA(SEND, [alice, bob]);
  const B = await make({ title: "B", after: A, users: [dave], dueIn: "1", dueUnit: "days" });
  await tick(SEND);
  await done(A, alice);
  await assertWaiting(B, "one of two done");
  await done(A, bob);
  assert.deepEqual(await sentNow(B, 1), ["dave"]);
});

// --- CH4 -----------------------------------------------------------------------------

test("CH4: A sent only outside: B starts when the creator marks A done", async () => {
  const SEND = new Date("2031-04-07T09:00:00Z");
  const A = await taskA(SEND, [], { emails: OUTSIDE });
  const B = await make({ title: "B", after: A, users: [dave], dueIn: "1", dueUnit: "days" });
  await tick(SEND);
  assert.deepEqual(await sentTo(A), [OUTSIDE], "control: A went outside only");
  await assertWaiting(B, "A sent, not marked done");
  const [o] = await occurrences(A);
  assert.ok(o);
  assert.equal(await setOccurrenceDone(await actor(), s.companyId, o.id, true), null);
  assert.deepEqual(await sentNow(B, 1), ["dave"]);
});

// --- CH5 -----------------------------------------------------------------------------

test("CH5: un-marking A after B started leaves B sent", async () => {
  const SEND = new Date("2031-05-05T09:00:00Z");
  const A = await taskA(SEND, [alice]);
  const B = await make({ title: "B", after: A, users: [dave], dueIn: "1", dueUnit: "days" });
  await tick(SEND);
  await done(A, alice);
  assert.deepEqual(await sentNow(B, 1), ["dave"]);
  const was = await row(B);
  const occ = await occurrences(B);
  await done(A, alice, false);
  await tick(new Date());
  const now = await row(B);
  assert.equal(now.status, was.status, "status unchanged");
  assert.notEqual(now.send_at.getTime(), WAITING_AT.getTime(), "not back to waiting");
  assert.equal(now.deleted_at, null);
  assert.deepEqual(
    (await occurrences(B)).map((o) => o.id),
    occ.map((o) => o.id),
    "its occurrence stays",
  );
  assert.deepEqual(await sentTo(B), ["dave"]);
  assert.ok(await assignment(B, dave), "dave still has B to do");
});

// --- CH6 -----------------------------------------------------------------------------

test("CH6: A -> B -> C: each starts when the one before is done", async () => {
  const SEND = new Date("2031-06-02T09:00:00Z");
  const A = await taskA(SEND, [alice]);
  const B = await make({ title: "B", after: A, users: [bob], dueIn: "1", dueUnit: "days" });
  const C = await make({ title: "C", after: B, users: [dave], dueIn: "1", dueUnit: "days" });
  assert.equal((await row(C)).after_id, B);
  await tick(SEND);
  await assertWaiting(B, "A not done");
  await assertWaiting(C, "A not done");
  await done(A, alice);
  assert.deepEqual(await sentNow(B, 1), ["bob"]);
  await assertWaiting(C, "B started, not done");
  await done(B, bob);
  assert.deepEqual(await sentNow(C, 1), ["dave"]);
});

// --- CH7 -----------------------------------------------------------------------------

test("CH7: A can only be a one-time task the creator can see, not done, cancelled or rejected; B can't wait for itself or form a loop", async (t) => {
  const SEND = new Date("2031-07-07T09:00:00Z");
  const at = (n: number) => new Date(SEND.getTime() + n * DAY);
  const open = await taskA(at(0), [dave], { title: "Open" });
  const sentNotDone = await taskA(at(1), [dave], { title: "Sent, not done" });
  const isDone = await taskA(at(2), [dave], { title: "Done" });
  const cancelled = await taskA(at(3), [dave], { title: "Cancelled" });
  const deleted = await taskA(at(4), [dave], { title: "Deleted" });
  const repeating = await make({ title: "Repeating", sendAt: at(5), due: new Date(at(5).getTime() + HOUR), users: [dave], repeat: "weekly" });
  const reminder = await make({ title: "Plain reminder", kind: "reminder", sendAt: at(6), users: [dave] });
  const rejected = await taskA(at(7), [carol], { title: "Rejected" }, mia);
  const forAlice = await taskA(at(8), [alice], { title: "For alice" });
  await tick(at(1));
  await tick(at(2));
  await done(isDone, dave);
  assert.equal(await cancelReminder(await actor(), s.companyId, cancelled), null);
  assert.equal(await deleteReminder(await actor(), s.companyId, deleted), null);
  assert.equal((await row(rejected)).status, "pending_approval", "control: mia's task to carol needs approval");
  assert.equal(await decideReminder(await actor(), s.companyId, rejected, false, "No"), null);
  assert.equal((await row(rejected)).status, "rejected");

  const choices = async (who: string, exclude?: string) => (await chainChoices(s.companyId, await actor(who), exclude)).map((x) => x.id);
  const label = (id: string) =>
    ({ [open]: "open", [sentNotDone]: "sentNotDone", [isDone]: "done", [cancelled]: "cancelled", [deleted]: "deleted", [repeating]: "repeating", [reminder]: "reminder", [rejected]: "rejected", [forAlice]: "forAlice" })[id] ?? id;

  await t.test("the choices: open one-time tasks (sent or not); not done, cancelled, deleted, rejected, repeating or plain reminders", async () => {
    const mine = await choices(olga);
    for (const id of [open, sentNotDone, forAlice]) assert.ok(mine.includes(id), `${label(id)} offered`);
    for (const id of [isDone, cancelled, deleted, rejected, repeating, reminder]) assert.ok(!mine.includes(id), `${label(id)} not offered`);
  });

  await t.test("only tasks the creator can see", async () => {
    const hers = await choices(alice);
    assert.ok(hers.includes(forAlice), "her own task to do is offered");
    assert.ok(!hers.includes(open), "olga's task to dave isn't");
    assert.equal(await reminderAccess(s.companyId, await actor(alice), { id: open, createdBy: olga }), null, "control: alice can't open it");
  });

  await t.test("saving refuses the same tasks the list leaves out", async () => {
    for (const id of [isDone, cancelled, deleted, rejected, repeating, reminder]) {
      const r = await attempt({ title: `B after ${label(id)}`, after: id, users: [alice] });
      assert.ok(r.error, `waiting for ${label(id)} is refused`);
    }
    const r = await attempt({ title: "B after an unseen task", after: open, users: [bob] }, alice);
    assert.ok(r.error, "alice can't chain to a task she can't see");
    const ok = await attempt({ title: "B after open", after: open, users: [alice] });
    assert.equal(ok.error, undefined, "control: waiting for an open task is fine");
  });

  await t.test("B can't wait for itself", async () => {
    const B = await make({ title: "B self", after: open, users: [alice] });
    assert.ok(!(await choices(olga, B)).includes(B), "not offered to itself");
    assert.notEqual(await edit(B, { title: "B self", after: B, users: [alice] }), null, "saving B to wait for B is refused");
    assert.equal((await row(B)).after_id, open);
  });

  await t.test("no loops: A -> B -> C, then A waiting for C (or B) is refused", async () => {
    const A2 = await taskA(at(9), [dave], { title: "A2" });
    const B2 = await make({ title: "B2", after: A2, users: [alice] });
    const C2 = await make({ title: "C2", after: B2, users: [bob] });
    assert.notEqual(await edit(A2, { title: "A2", after: B2, users: [dave] }), null, "A2 waiting for B2 is refused");
    assert.notEqual(await edit(A2, { title: "A2", after: C2, users: [dave] }), null, "A2 waiting for C2 is refused");
    assert.equal((await row(A2)).after_id, null);
    const other = await taskA(at(10), [dave], { title: "Unchained" });
    assert.equal(await edit(other, { title: "Unchained", after: open, users: [dave] }), null, "control: an unchained task can be set to wait");
  });
});

// --- CH8 -----------------------------------------------------------------------------

test("CH8: A cancelled or deleted: B is cancelled and B's creator is told in the app", async (t) => {
  const SEND = new Date("2031-08-04T09:00:00Z");
  const told = async (id: string) => (await q("select kind, text from notifications where user_id = $1 and reminder_id = $2", [mia, id])) as { kind: string; text: string }[];

  await t.test("A cancelled before it was sent", async () => {
    const A = await taskA(SEND, [mia, alice]);
    const B = await make({ title: "B", after: A, users: [alice], dueIn: "1", dueUnit: "days" }, mia);
    assert.equal((await row(B)).status, "scheduled", "control: in mia's scope, no approval");
    assert.deepEqual(await told(B), []);
    assert.equal(await cancelReminder(await actor(), s.companyId, A), null);
    assert.equal((await row(B)).status, "cancelled", "B is cancelled");
    assert.ok((await told(B)).length >= 1, "mia is told in the app");
    await tick(SEND);
    await tick(new Date());
    assert.deepEqual(await sentTo(B), [], "B never sent");
  });

  await t.test("A deleted after it was sent", async () => {
    const S2 = new Date(SEND.getTime() + 7 * DAY);
    const A = await taskA(S2, [mia, alice]);
    const B = await make({ title: "B", after: A, users: [alice], dueIn: "1", dueUnit: "days" }, mia);
    await tick(S2);
    assert.equal(await deleteReminder(await actor(), s.companyId, A), null);
    assert.equal((await row(B)).status, "cancelled", "B is cancelled");
    assert.ok((await told(B)).length >= 1, "mia is told in the app");
    await tick(new Date());
    assert.deepEqual(await sentTo(B), [], "B never sent");
  });
});

// --- CH9 -----------------------------------------------------------------------------

test("CH9: B is approved when created, not when it starts; still waiting for approval when A is done, it's sent once approved", async (t) => {
  const SEND = new Date("2031-09-01T09:00:00Z");

  await t.test("in scope: no approval at creation, none at start", async () => {
    const A = await taskA(SEND, [mia]);
    const B = await make({ title: "B in scope", after: A, users: [alice] }, mia);
    assert.equal((await row(B)).status, "scheduled");
    await tick(SEND);
    await done(A, mia);
    assert.deepEqual(await sentNow(B, 1), ["alice"]);
    assert.notEqual((await row(B)).status, "pending_approval");
  });

  await t.test("out of scope: needs approval when created; approved, it still waits for A, then is sent", async () => {
    const S2 = new Date(SEND.getTime() + 7 * DAY);
    const A = await taskA(S2, [mia]);
    const B = await make({ title: "B to carol", after: A, users: [carol] }, mia);
    assert.equal((await row(B)).status, "pending_approval", "approval asked at creation");
    assert.equal(await decideReminder(await actor(), s.companyId, B, true), null);
    assert.equal((await row(B)).status, "scheduled");
    await assertWaiting(B, "approved but A not done");
    await tick(S2);
    await done(A, mia);
    assert.deepEqual(await sentNow(B, 1), ["carol"]);
  });

  await t.test("A done while B still waits for approval: nothing yet, then sent once approved", async () => {
    const S3 = new Date(SEND.getTime() + 14 * DAY);
    const A = await taskA(S3, [mia]);
    const B = await make({ title: "B to carol later", after: A, users: [carol] }, mia);
    assert.equal((await row(B)).status, "pending_approval");
    await tick(S3);
    await done(A, mia);
    await tick(new Date());
    assert.equal((await row(B)).status, "pending_approval", "still waiting for approval");
    assert.deepEqual(await sentTo(B), [], "not sent before approval");
    assert.equal(await decideReminder(await actor(), s.companyId, B, true), null);
    assert.deepEqual(await sentNow(B, 1), ["carol"], "sent once approved");
  });
});

// --- CH10 ----------------------------------------------------------------------------

test("CH10: B knows A ('Starts when A is done'); A lists 'Then: B' only to those who can open B", async (t) => {
  const SEND = new Date("2031-10-06T09:00:00Z");
  const A = await taskA(SEND, [dave], { title: "Collect laptop" });
  const B = await make({ title: "Set up accounts", after: A, users: [alice] });

  await t.test("B's page and the list: waiting for A", async () => {
    const g = await getReminder(s.companyId, B);
    assert.ok(g);
    assert.equal(g.afterId, A, "B links to A");
    assert.equal(statusLabel(g), "Waiting");
  });

  await t.test("A's next steps: B for someone who can open it, nothing for someone who can't", async () => {
    const forOlga = await nextSteps(s.companyId, await actor(olga), A);
    assert.deepEqual(
      forOlga.map((x) => [x.id, x.title]),
      [[B, "Set up accounts"]],
    );
    assert.notEqual(await reminderAccess(s.companyId, await actor(dave), { id: A, createdBy: olga }), null, "control: dave can open A");
    assert.equal(await reminderAccess(s.companyId, await actor(dave), { id: B, createdBy: olga }), null, "control: dave can't open B");
    assert.deepEqual(await nextSteps(s.companyId, await actor(dave), A), [], "dave doesn't see B");
  });

  await t.test("the wording, the link to A, and 'Add a next step' opening a task waiting for A", { skip: "browser: page and list wording, links, the Add a next step button" }, () => {});
});

// --- CH11 ----------------------------------------------------------------------------

test("CH11: B isn't in the calendar or Google before it starts", async (t) => {
  const SEND = new Date("2031-11-03T09:00:00Z");
  const A = await taskA(SEND, [alice]);
  const B = await make({ title: "B", after: A, users: [alice], dueIn: "1", dueUnit: "days" });
  const day = (d: Date, n: number) => local(new Date(d.getTime() + n * DAY)).slice(0, 10);
  const entries = async (who: string, range: { from: string; to: string }) => [...((await calendarRange(s.companyId, await actor(who), "UTC", range))?.days.values() ?? [])].flat();
  const notShown = async (ranges: { from: string; to: string }[]) => {
    for (const who of [olga, alice])
      for (const range of ranges)
        assert.deepEqual(
          (await entries(who, range)).filter((e) => e.reminderId === B).map((e) => e.title),
          [],
          `${name(who)} ${range.from}..${range.to}`,
        );
  };

  await t.test("the calendar: not around A's date or today", async () => {
    const around = { from: day(SEND, -1), to: day(SEND, 3) };
    await notShown([around, { from: day(new Date(), -1), to: day(new Date(), 3) }]);
    assert.ok((await entries(olga, around)).some((e) => e.reminderId === A), "control: A is in the calendar");
  });

  await t.test("the calendar: not on the placeholder date either", async () => {
    await notShown([{ from: day(WAITING_AT, -2), to: day(WAITING_AT, 1) }]);
  });

  await t.test("Google: not synced", async () => {
    const gOlga = fakeGoogle();
    const gAlice = fakeGoogle();
    assert.equal(await connectGoogle(s.companyId, olga, `code-${randomUUID()}`, gOlga.fetch), null);
    assert.equal(await connectGoogle(s.companyId, alice, `code-${randomUUID()}`, gAlice.fetch), null);
    for (const now of [new Date(SEND.getTime() - DAY), new Date()]) {
      assert.equal(await syncGoogle(olga, gOlga.fetch, now), "synced");
      assert.equal(await syncGoogle(alice, gAlice.fetch, now), "synced");
    }
    assert.ok(gOlga.summaries(A).length > 0, "control: A is in olga's Google calendar");
    assert.deepEqual(gOlga.summaries(B), [], "B isn't in olga's Google calendar");
    assert.deepEqual(gAlice.summaries(B), [], "B isn't in alice's Google calendar");
  });
});

// --- CH12 ----------------------------------------------------------------------------

test("CH12: a sub-task as A: B starts when that sub-task is done", async () => {
  const SEND = new Date("2031-12-01T09:00:00Z");
  const P = await make({
    title: "Onboarding",
    sendAt: SEND,
    due: new Date(SEND.getTime() + 3 * DAY),
    users: [dave],
    subs: [
      { title: "Laptop", due: new Date(SEND.getTime() + DAY), users: [alice] },
      { title: "Accounts", due: new Date(SEND.getTime() + DAY), users: [bob] },
    ],
  });
  const subs = Object.fromEntries(((await q("select id, title from reminders where parent_id = $1", [P])) as { id: string; title: string }[]).map((r) => [r.title.replace(/ \([^()]*\)$/, ""), r.id]));
  assert.ok(subs.Laptop && subs.Accounts, "control: the sub-tasks exist");
  assert.ok((await chainChoices(s.companyId, await actor(olga))).some((x) => x.id === subs.Laptop), "the sub-task is offered as A");
  const B = await make({ title: "B", after: subs.Laptop, users: [dave], dueIn: "1", dueUnit: "days" });
  assert.equal((await row(B)).after_id, subs.Laptop);
  await tick(SEND);
  await done(subs.Accounts, bob);
  await assertWaiting(B, "the other sub-task done");
  await done(subs.Laptop, alice);
  assert.deepEqual(await sentNow(B, 1), ["dave"]);
});

// A minimal fake Google: token exchange, calendar create, event writes.
function fakeGoogle() {
  const calls: { method: string; url: string; body: string }[] = [];
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const email = `p${randomUUID().slice(0, 8)}@gmail.com`;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body ? String(init.body) : "";
    calls.push({ method, url, body });
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return json({
        access_token: `ya29.fake-${randomUUID()}`,
        expires_in: 3599,
        token_type: "Bearer",
        refresh_token: `1//fake-${randomUUID()}`,
        scope: "openid email https://www.googleapis.com/auth/calendar.app.created",
        id_token: `${b64({ alg: "RS256" })}.${b64({ iss: "https://accounts.google.com", sub: email, email, email_verified: true })}.sig`,
      });
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json({});
    const path = new URL(url).pathname.replace(/^\/calendar\/v3/, "");
    if (path === "/calendars" && method === "POST") return json({ id: `${randomUUID()}@group.calendar.google.com`, summary: "NotifyHub" });
    if (method === "GET" && path.endsWith("/events")) return json({ items: [] });
    if (method === "GET") return json({ error: { code: 404, message: "Not Found" } }, 404);
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json({ id: randomUUID().replace(/-/g, ""), ...JSON.parse(body || "{}") });
  }) as typeof fetch;
  return {
    fetch: f,
    // The titles written for one reminder (its page link is in the event).
    summaries: (reminderId: string) =>
      calls
        .filter(
          (c) =>
            c.url.startsWith("https://www.googleapis.com/calendar/v3") &&
            c.url.includes("/events") &&
            ["POST", "PUT", "PATCH"].includes(c.method) &&
            c.body.includes(`/reminders/${reminderId}`),
        )
        .map((c) => String((JSON.parse(c.body || "{}") as { summary?: string }).summary ?? "")),
  };
}
