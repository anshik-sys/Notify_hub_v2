import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { myOpenTasks, myTaskStatus, setDone, taskProgress } from "./tasks";
import { seeder } from "./test-helpers";

const s = seeder();
let alice: string, bob: string, reminderId: string, occ1: string, occ2: string, dA: string, dB: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

before(async () => {
  await s.company();
  [alice, bob] = [await s.user(), await s.user()];
  [{ id: reminderId }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes)
     values ($1, $2, $3, 'Submit timesheet', 'HR', now() + interval '1 hour', 'scheduled', 'UTC', '2026-01-01T00:00', true, 60) returning id`,
    [s.companyId, `R-T${s.companyId.slice(0, 5).toUpperCase()}`, alice],
  );
  const occ = async (at: string) =>
    (
      await q(
        "insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, due_at) values ($1, $2, $3, 'sent', $3::timestamptz + interval '1 hour') returning id",
        [s.companyId, reminderId, at],
      )
    )[0].id as string;
  [occ1, occ2] = [await occ("2026-01-01T09:00Z"), await occ("2026-01-08T09:00Z")];
  const assign = async (o: string, userId: string) =>
    (
      await q(
        "insert into task_assignments (company_id, reminder_id, occurrence_id, user_id) values ($1, $2, $3, $4) returning id",
        [s.companyId, reminderId, o, userId],
      )
    )[0].id as string;
  [dA, dB] = [await assign(occ1, alice), await assign(occ1, bob)];
});
after(async () => {
  await s.cleanup();
  await db.$client.end();
});

test("setDone: only your own; undo clears; progress counts assignees only", async () => {
  assert.match((await setDone(bob, s.companyId, dA, true))!, /isn't yours/);
  assert.deepEqual(await q("select done_at from task_assignments where id = $1", [dA]), [{ done_at: null }]);

  assert.deepEqual(await taskProgress(s.companyId, occ1).then((p) => [p.done, p.total]), [0, 2]);
  assert.equal(await setDone(alice, s.companyId, dA, true), null);
  assert.deepEqual(await taskProgress(s.companyId, occ1).then((p) => [p.done, p.total]), [1, 2]);
  assert.equal(await setDone(alice, s.companyId, dA, false), null);
  assert.deepEqual(await taskProgress(s.companyId, occ1).then((p) => p.done), 0);
});

test("open tasks and a fresh second occurrence", async () => {
  assert.equal((await myOpenTasks(s.companyId, bob)).length, 1);
  assert.equal(await setDone(bob, s.companyId, dB, true), null);
  assert.equal((await myOpenTasks(s.companyId, bob)).length, 0);

  // Next week's occurrence: bob starts not-done again.
  await q("insert into task_assignments (company_id, reminder_id, occurrence_id, user_id) values ($1, $2, $3, $4)", [
    s.companyId,
    reminderId,
    occ2,
    bob,
  ]);
  const mine = await myTaskStatus(s.companyId, bob, reminderId);
  assert.equal(mine?.doneAt, null); // latest occurrence
  assert.equal(mine?.dueAt?.toISOString(), "2026-01-08T10:00:00.000Z");
  assert.equal((await myOpenTasks(s.companyId, bob)).length, 1);
});

test("the creator hears once when everyone is done", async () => {
  const done = async () => (await q("select kind from notifications where user_id = $1 and kind = 'tasks_done'", [alice])).length;
  await q("update task_assignments set done_at = null where occurrence_id = $1", [occ1]); // fresh start
  assert.equal(await setDone(alice, s.companyId, dA, true), null);
  assert.equal(await done(), 0);
  assert.equal(await setDone(bob, s.companyId, dB, true), null);
  assert.equal(await done(), 1);
  await setDone(bob, s.companyId, dB, false);
  await setDone(bob, s.companyId, dB, true);
  assert.equal(await done(), 1); // undo and redo: still once
});
