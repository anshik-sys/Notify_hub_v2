import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { loadAccess } from "@/lib/permissions";
import { reminderAccess } from "@/lib/reminders";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { escalateOverdue } from "./escalation";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
let creator: string, manager: string, oldManager: string, bob: string, carol: string, reminderId: string;
const DAY = 86_400_000;

// A task occurrence due `daysAgo` days before now, assigned to the given people.
async function task(daysAgo: number, assignees: string[]) {
  const [r] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes)
     values ($1, $2, $3, 'Fill the survey', 'HR', now(), 'sent', 'UTC', '2026-01-01T00:00', true, 60) returning id`,
    [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, creator],
  );
  const [o] = await q(
    `insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, due_at) values ($1, $2, $3, 'sent', $3) returning id`,
    [s.companyId, r.id, new Date(Date.now() - daysAgo * DAY)],
  );
  for (const u of assignees)
    await q("insert into task_assignments (company_id, reminder_id, occurrence_id, user_id) values ($1, $2, $3, $4)", [s.companyId, r.id, o.id, u]);
  return r.id as string;
}

before(async () => {
  await s.company();
  [creator, manager, oldManager, bob, carol] = [await s.user(), await s.user(), await s.user(), await s.user(), await s.user()];
  await q(`update "user" set deactivated_at = now() where id = $1`, [oldManager]);
  await q("update companies set escalate_after_days = 2 where id = $1", [s.companyId]);
  const [{ id: sales }] = await q("insert into departments (company_id, name) values ($1, 'Sales') returning id", [s.companyId]);
  for (const [u, mgr] of [[bob, false], [manager, true], [oldManager, true]] as const)
    await q("insert into department_members values ($1, $2, $3, $4)", [s.companyId, sales, u, mgr]);
  reminderId = await task(3, [bob, carol]); // carol is in no department
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
  await db.$client.end();
});

test("escalation: managers (else the creator) told once; old and done ones skipped; off when unset", async () => {
  const sent: string[] = [];
  const capture = (async (m: { to: string }) => void sent.push(m.to)) as never;
  const done = await task(3, [bob]);
  await q("update task_assignments set done_at = now() where reminder_id = $1", [done]);
  const ancient = await task(30, [bob]); // crossed the threshold long ago: not flooded

  const managerAccess = { id: manager, email: "m@x.test", access: await loadAccess(s.companyId, manager) };
  assert.equal(await reminderAccess(s.companyId, managerAccess, { id: reminderId, createdBy: creator }), null);

  assert.equal(await escalateOverdue(new Date(), s.companyId, capture), 2);
  const told = await q("select user_id, reminder_id, text from notifications where kind = 'escalated' and company_id = $1 order by text", [s.companyId]);
  assert.deepEqual(
    told.map((n) => [n.user_id, n.reminder_id]).sort(),
    [[manager, reminderId], [creator, reminderId]].sort(), // bob -> his manager (not the deactivated one); carol -> the creator
  );
  assert.match(told[0].text, /2 days after it was due/);
  assert.equal(sent.length, 2);
  assert.deepEqual(await q("select id from notifications where reminder_id = any($1)", [[done, ancient]]), []);

  // The manager can now open the task, as a viewer.
  assert.equal(await reminderAccess(s.companyId, managerAccess, { id: reminderId, createdBy: creator }), "viewer");

  // Once: a second tick finds nothing.
  assert.equal(await escalateOverdue(new Date(), s.companyId, capture), 0);

  // Turned off: nothing, even for a fresh overdue one.
  await q("update companies set escalate_after_days = null where id = $1", [s.companyId]);
  await task(3, [bob]);
  assert.equal(await escalateOverdue(new Date(), s.companyId, capture), 0);
});
