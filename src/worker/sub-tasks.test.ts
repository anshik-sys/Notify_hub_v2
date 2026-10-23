// Sub-tasks (PRD 14.5): made through the form, sent by the worker, done when
// all are. Dates are in 2031 and the worker gets an explicit `now`, so a live
// worker never picks them up.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "@/lib/auth";
import type { sendMail } from "@/lib/mail";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "@/lib/permissions";
import { cancelReminder, createReminder, decideReminder, deleteReminder, formToRaw, updateReminder, validateInput } from "@/lib/reminders";
import { setDone } from "@/lib/tasks";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { deliverOne, dispatchDue } from "./delivery";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
let olga: string, alice: string, bob: string, mia: string, ops: string;
const local = (d: Date) => d.toISOString().slice(0, 16);
const SEND = new Date("2031-03-03T09:00:00Z");
const H = 3_600_000;

type Sub = { id?: string; title: string; due: Date; users?: string[] };
const post = (subs: Sub[], o: { repeat?: string; users?: string[]; id?: string } = {}) => {
  const fd = new FormData();
  const f: [string, string][] = [
    ["title", "Onboarding"],
    ["description", ""],
    ["senderName", ""],
    ...(o.users ?? [alice]).map((u): [string, string] => ["users", u]),
    ["emails", ""],
    ["when", "later"],
    ["sendAt", local(SEND)],
    ["repeat", o.repeat ?? "none"],
    ["every", "1"],
    ["unit", "week"],
    ["monthlyBy", "day"],
    ["ends", "never"],
    ["until", ""],
    ["count", ""],
    ["channels", "email"],
    ["tags", ""],
    ["kind", "task"],
    ["due", local(new Date(SEND.getTime() + 48 * H))],
    ["remindBefore", "1440"],
    ...subs.flatMap((x, i): [string, string][] => [
      [`sub.${i}.id`, x.id ?? ""],
      [`sub.${i}.title`, x.title],
      [`sub.${i}.due`, local(x.due)],
      ...(x.users ?? []).map((u): [string, string] => [`sub.${i}.users`, u]),
    ]),
  ];
  for (const [k, v] of f) fd.append(k, v);
  return validateInput(formToRaw(fd), "UTC", "Alerts | Test Co", new Date(), []);
};
const actor = async (id: string) => ({ id, access: await loadAccess(s.companyId, id) });
const children = (id: string) => q("select id, title, status, due_after_minutes, notify_before, deleted_at from reminders where parent_id = $1 order by created_at", [id]);
const targets = (id: string) => q("select kind, ref from reminder_targets where reminder_id = $1 order by ref", [id]);

async function make(subs: Sub[], by = olga) {
  const p = post(subs);
  assert.equal(p.error, undefined, p.error);
  const r = await createReminder(await actor(by), s.companyId, p.input!);
  assert.ok("id" in r, JSON.stringify(r));
  return r.id;
}
async function tick(now: Date) {
  const sends: string[] = [];
  await dispatchDue(async (x) => void sends.push(...x), s.companyId, now);
  for (const d of sends) await deliverOne(d, (async () => {}) as unknown as typeof sendMail);
}

before(async () => {
  await s.company();
  olga = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  alice = await s.user({ roles: [MEMBER_ROLE_ID] });
  bob = await s.user({ roles: [MEMBER_ROLE_ID] });
  mia = await s.user({ roles: [MEMBER_ROLE_ID] });
  ({ rows: [{ id: ops }] } = await s.owner.query("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]));
  await s.owner.query("insert into department_members values ($1, $2, $3, false), ($1, $2, $4, false)", [s.companyId, ops, mia, alice]);
});
after(async () => {
  await s.cleanup();
  await Promise.all([db.$client.end(), authDb.$client.end(), ownerDb.$client.end()]);
});

test("saved with the task: titles, own or the task's people, due, fitting remind-before", async () => {
  const id = await make([
    { title: "Laptop", due: new Date(SEND.getTime() + 2 * H), users: [bob] },
    { title: "Accounts", due: new Date(SEND.getTime() + 30 * H) },
  ]);
  const [a, b] = await children(id);
  assert.equal(a.title, "Laptop (Onboarding)");
  assert.equal(b.title, "Accounts (Onboarding)");
  assert.equal(a.due_after_minutes, 120);
  assert.deepEqual(a.notify_before, []); // 1 day doesn't fit a 2-hour sub-task
  assert.deepEqual(b.notify_before, [1440]);
  assert.deepEqual(await targets(a.id), [{ kind: "user", ref: bob }]);
  assert.deepEqual(await targets(b.id), [{ kind: "user", ref: alice }]); // the task's own
});

test("refused: repeating, or due after the task", async () => {
  assert.match(post([{ title: "X", due: new Date(SEND.getTime() + H) }], { repeat: "daily" }).error ?? "", /repeating task can’t have sub-tasks/);
  assert.match(post([{ title: "X", due: new Date(SEND.getTime() + 49 * H) }]).error ?? "", /no later than the task/);
  assert.match(post([{ title: "X", due: SEND }]).error ?? "", /after the task is sent/);
});

test("sent: the task sends nothing, each sub-task to its people; done when all are, told once", async () => {
  const id = await make([
    { title: "Laptop", due: new Date(SEND.getTime() + 2 * H), users: [bob] },
    { title: "Accounts", due: new Date(SEND.getTime() + 3 * H), users: [alice] },
  ]);
  const [a, b] = await children(id);
  await tick(new Date(SEND.getTime() + 1000));
  assert.deepEqual(await q("select status from reminders where id = $1", [id]), [{ status: "sent" }]);
  assert.equal((await q("select 1 from deliveries where reminder_id = $1", [id])).length, 0);
  assert.equal((await q("select 1 from task_assignments where reminder_id = $1", [id])).length, 0);
  const [bobA] = await q("select id from task_assignments where reminder_id = $1 and user_id = $2", [a.id, bob]);
  const [aliceA] = await q("select id from task_assignments where reminder_id = $1 and user_id = $2", [b.id, alice]);
  assert.ok(bobA && aliceA);
  const parentDone = async () => (await q("select done_at from reminder_occurrences where reminder_id = $1", [id]))[0].done_at;
  const told = async () => (await q("select reminder_id from notifications where user_id = $1 and kind = 'tasks_done' and reminder_id = any($2)", [olga, [id, a.id, b.id]])).map((n) => n.reminder_id);

  assert.equal(await setDone(bob, s.companyId, bobA.id, true), null);
  assert.equal(await parentDone(), null);
  assert.deepEqual(await told(), []);
  assert.equal(await setDone(alice, s.companyId, aliceA.id, true), null);
  assert.ok(await parentDone());
  assert.deepEqual(await told(), [id]);
  assert.equal(await setDone(alice, s.companyId, aliceA.id, false), null);
  assert.equal(await parentDone(), null);
  assert.equal(await setDone(alice, s.companyId, aliceA.id, true), null);
  assert.deepEqual(await told(), [id]); // still once
});

test("edit: a cleared title removes that sub-task, the others keep their ids; a sub-task can't be edited alone", async () => {
  const id = await make([
    { title: "Laptop", due: new Date(SEND.getTime() + 2 * H) },
    { title: "Accounts", due: new Date(SEND.getTime() + 3 * H) },
  ]);
  const [a, b] = await children(id);
  const p = post([
    { id: a.id, title: "", due: new Date(SEND.getTime() + 2 * H) },
    { id: b.id, title: "Accounts and email", due: new Date(SEND.getTime() + 3 * H) },
    { title: "Intro call", due: new Date(SEND.getTime() + 4 * H) },
  ]);
  assert.equal(await updateReminder(await actor(olga), s.companyId, id, p.input!), null);
  const now = await children(id);
  assert.deepEqual(
    now.map((c) => c.title),
    ["Accounts and email (Onboarding)", "Intro call (Onboarding)"],
  );
  assert.equal(now[0].id, b.id);
  assert.match((await updateReminder(await actor(olga), s.companyId, b.id, p.input!)) ?? "", /sub-task/);
  assert.match((await cancelReminder(await actor(olga), s.companyId, b.id)) ?? "", /sub-task/);
});

test("approval: one sub-task out of scope holds the whole task; approving releases all", async () => {
  // mia (Ops) may send to alice (Ops) but not to bob.
  const p = post([{ title: "Laptop", due: new Date(SEND.getTime() + 2 * H), users: [bob] }]);
  const r = await createReminder(await actor(mia), s.companyId, p.input!);
  assert.ok("id" in r);
  assert.deepEqual((await q("select status from reminders where id = $1", [r.id]))[0], { status: "pending_approval" });
  assert.deepEqual((await children(r.id)).map((c) => c.status), ["pending_approval"]);
  assert.equal(await decideReminder(await actor(olga), s.companyId, r.id, true), null);
  assert.deepEqual((await children(r.id)).map((c) => c.status), ["scheduled"]);
});

test("delete or cancel the task: its sub-tasks go with it", async () => {
  const one = await make([{ title: "Laptop", due: new Date(SEND.getTime() + 2 * H) }]);
  assert.equal(await cancelReminder(await actor(olga), s.companyId, one), null);
  assert.deepEqual((await children(one)).map((c) => c.status), ["cancelled"]);
  const two = await make([{ title: "Laptop", due: new Date(SEND.getTime() + 2 * H) }]);
  assert.equal(await deleteReminder(await actor(olga), s.companyId, two), null);
  const [c] = await children(two);
  assert.equal(c.status, "cancelled");
  assert.ok(c.deleted_at);
});
