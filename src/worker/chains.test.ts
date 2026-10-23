// Chains (PRD 14.5): "start when a task is done". A's dates are in 2031 and the
// worker gets an explicit `now`. A started B is due "now" in real time, so a
// live worker may send it first; the checks only look at what exists.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "@/lib/auth";
import type { sendMail } from "@/lib/mail";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "@/lib/permissions";
import { cancelReminder, createReminder, deleteReminder, formToRaw, setOccurrenceDone, updateReminder, validateInput } from "@/lib/reminders";
import { setDone, WAITING_AT } from "@/lib/tasks";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { deliverOne, dispatchDue } from "./delivery";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
let olga: string, alice: string, bob: string, mia: string;
const local = (d: Date) => d.toISOString().slice(0, 16);
const SEND = new Date("2031-04-07T09:00:00Z");
const H = 3_600_000;
const LATER = new Date(SEND.getTime() + 1000);

type Opts = { title: string; after?: string; users?: string[]; emails?: string; repeat?: string; kind?: string; subs?: string[] };
const form = (o: Opts) => {
  const fd = new FormData();
  const f: [string, string][] = [
    ["title", o.title],
    ["description", ""],
    ["senderName", ""],
    ...(o.users ?? [alice]).map((u): [string, string] => ["users", u]),
    ["emails", o.emails ?? ""],
    ["when", o.after ? "after" : "later"],
    ["after", o.after ?? ""],
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
    ["kind", o.kind ?? "task"],
    ["due", local(new Date(SEND.getTime() + 48 * H))],
    ["dueIn", "2"],
    ["dueUnit", "days"],
    ...(o.subs ?? []).flatMap((t, i): [string, string][] => [
      [`sub.${i}.title`, t],
      [`sub.${i}.due`, local(new Date(SEND.getTime() + H))],
    ]),
  ];
  for (const [k, v] of f) fd.append(k, v);
  return validateInput(formToRaw(fd), "UTC", "Alerts | Test Co", new Date(), []);
};
const actor = async (id: string) => ({ id, access: await loadAccess(s.companyId, id) });
async function make(o: Opts, by = olga) {
  const p = form(o);
  if (p.error !== undefined) return { error: p.error };
  return createReminder(await actor(by), s.companyId, p.input);
}
async function ok(o: Opts, by = olga) {
  const r = await make(o, by);
  assert.ok("id" in r, JSON.stringify(r));
  return r.id;
}
async function tick(now: Date) {
  const sends: string[] = [];
  await dispatchDue(async (x) => void sends.push(...x), s.companyId, now);
  for (const d of sends) await deliverOne(d, (async () => {}) as unknown as typeof sendMail);
}
const row = async (id: string) => (await q("select status, send_at, due_after_minutes from reminders where id = $1", [id]))[0];
const waiting = async (id: string) => (await row(id)).send_at.getTime() === WAITING_AT.getTime();
const assignment = async (id: string, user: string) => (await q("select id from task_assignments where reminder_id = $1 and user_id = $2", [id, user]))[0].id as string;

before(async () => {
  await s.company();
  olga = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  alice = await s.user({ roles: [MEMBER_ROLE_ID] });
  bob = await s.user({ roles: [MEMBER_ROLE_ID] });
  mia = await s.user({ roles: [MEMBER_ROLE_ID] });
});
after(async () => {
  await s.cleanup();
  await Promise.all([db.$client.end(), authDb.$client.end(), ownerDb.$client.end()]);
});

test("B waits for A, starts when everyone has done A, due counted from then; C after B", async () => {
  const a = await ok({ title: "A", users: [alice, bob] });
  const b = await ok({ title: "B", after: a });
  const c = await ok({ title: "C", after: b, kind: "reminder" });
  assert.ok(await waiting(b));
  await tick(LATER);
  assert.equal((await q("select 1 from reminder_occurrences where reminder_id = $1", [b])).length, 0);
  assert.equal(await setDone(alice, s.companyId, await assignment(a, alice), true), null);
  assert.ok(await waiting(b), "one of two isn't enough (CH3)");
  const t0 = Date.now();
  assert.equal(await setDone(bob, s.companyId, await assignment(a, bob), true), null);
  const started = await row(b);
  assert.ok(started.send_at.getTime() >= t0 - 1000 && started.send_at.getTime() <= Date.now());
  assert.equal(started.due_after_minutes, 2 * 1440);
  // The live worker may hold B (skip locked) while this tick runs: wait for whichever sends it.
  for (let i = 0; i < 50 && !(await q("select 1 from task_assignments where reminder_id = $1", [b])).length; i++) {
    await tick(new Date(Date.now() + 1000));
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await q("select 1 from task_assignments where reminder_id = $1", [b])).length, 1);
  assert.ok(await waiting(c));
  // CH5: un-marking A leaves B sent.
  assert.equal(await setDone(bob, s.companyId, await assignment(a, bob), false), null);
  assert.equal(await waiting(b), false);
  assert.equal(await setDone(alice, s.companyId, await assignment(b, alice), true), null);
  assert.equal(await waiting(c), false);
});

test("A sent only outside starts B when the creator marks it done; a sub-task can be A", async () => {
  const a = await ok({ title: "Outside", users: [], emails: "x@outside-chain.example" });
  const b = await ok({ title: "B2", after: a });
  await tick(LATER);
  const [occ] = await q("select id from reminder_occurrences where reminder_id = $1", [a]);
  assert.equal(await setOccurrenceDone(await actor(olga), s.companyId, occ.id, true), null);
  assert.equal(await waiting(b), false);

  const parent = await ok({ title: "Onboarding", subs: ["Laptop"] });
  const [sub] = await q("select id from reminders where parent_id = $1", [parent]);
  const c = await ok({ title: "After laptop", after: sub.id });
  await tick(LATER);
  assert.equal(await setDone(alice, s.companyId, await assignment(sub.id, alice), true), null);
  assert.equal(await waiting(c), false);
});

test("refused: repeating, an event, sub-tasks, a done or repeating A, a loop, an A I can't see", async () => {
  const a = await ok({ title: "Open A" });
  assert.match(form({ title: "X", after: a, repeat: "daily" }).error ?? "", /can’t repeat/);
  assert.match(form({ title: "X", after: a, kind: "event" }).error ?? "", /start date/);
  assert.match(form({ title: "X", after: a, subs: ["S"] }).error ?? "", /can’t have sub-tasks/);
  const weekly = await ok({ title: "Weekly", repeat: "weekly" });
  assert.match(JSON.stringify(await make({ title: "X", after: weekly })), /doesn’t repeat/);
  const b = await ok({ title: "B3", after: a });
  const p = form({ title: "Open A", after: b });
  assert.match((await updateReminder(await actor(olga), s.companyId, a, p.input!)) ?? "", /wait for itself/);
  const mine = await ok({ title: "Olga's own", users: [olga] });
  assert.match(JSON.stringify(await make({ title: "X", after: mine, users: [mia] }, mia)), /wasn’t found/);
  const done = await ok({ title: "Done one", users: [] , emails: "y@outside-chain.example" });
  await tick(LATER);
  const [occ] = await q("select id from reminder_occurrences where reminder_id = $1", [done]);
  await setOccurrenceDone(await actor(olga), s.companyId, occ.id, true);
  assert.match(JSON.stringify(await make({ title: "X", after: done })), /already done/);
});

test("cancel or delete A: what waits for it (and for that) is cancelled, its creator told", async () => {
  const a = await ok({ title: "Cancel me" });
  const b = await ok({ title: "B4", after: a });
  const c = await ok({ title: "C4", after: b });
  assert.equal(await cancelReminder(await actor(olga), s.companyId, a), null);
  assert.deepEqual([(await row(b)).status, (await row(c)).status], ["cancelled", "cancelled"]);
  assert.equal((await q("select 1 from notifications where reminder_id = any($1) and kind = 'chain' and user_id = $2", [[b, c], olga])).length, 2);
  const d = await ok({ title: "Delete me" });
  const e = await ok({ title: "E4", after: d });
  assert.equal(await deleteReminder(await actor(olga), s.companyId, d), null);
  assert.equal((await row(e)).status, "cancelled");
});
