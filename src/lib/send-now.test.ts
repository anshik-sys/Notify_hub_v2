import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "./auth";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { sendNow, sendTest } from "./send-now";
import { seeder } from "./test-helpers";

const s = seeder();
let admin: string, creator: string, other: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const actor = async (id: string) => ({ id, email: `${id}@${s.domain}`, access: await loadAccess(s.companyId, id) });
const mk = async (status: string, recurrence: object | null) =>
  (
    await q(
      `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, recurrence)
       values ($1, $2, $3, 'Weekly sync', 'S', now() + interval '7 days', $4, 'UTC', '2026-01-01T09:00', $5) returning id`,
      [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, creator, status, recurrence ? JSON.stringify(recurrence) : null],
    )
  )[0].id as string;

before(async () => {
  await s.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  creator = await s.user({ roles: [MEMBER_ROLE_ID] });
  other = await s.user({ roles: [MEMBER_ROLE_ID] });
});
after(async () => {
  await s.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

test("sendNow: one-time reschedules to now; repeating asks for an extra occurrence", async () => {
  const once = await mk("scheduled", null);
  assert.deepEqual(await sendNow(await actor(creator), s.companyId, once), { mode: "rescheduled" });
  const [o] = await q("select send_at, send_now_at, status from reminders where id = $1", [once]);
  assert.ok(Math.abs(o.send_at.getTime() - Date.now()) < 10_000);
  assert.deepEqual([o.send_now_at, o.status], [null, "scheduled"]);

  const weekly = await mk("scheduled", { freq: "weekly", interval: 1, weekdays: [0], end: { type: "never" } });
  const before = (await q("select send_at from reminders where id = $1", [weekly]))[0].send_at.getTime();
  assert.deepEqual(await sendNow(await actor(admin), s.companyId, weekly), { mode: "extra" }); // admin: reminders.send_now
  const [w] = await q("select send_at, send_now_at from reminders where id = $1", [weekly]);
  assert.equal(w.send_at.getTime(), before); // the schedule is untouched
  assert.ok(w.send_now_at);
});

test("sendNow: refusals", async () => {
  const pending = await mk("pending_approval", null);
  assert.match((await sendNow(await actor(creator), s.companyId, pending)).error!, /waiting for approval/);
  for (const st of ["cancelled", "sent"]) {
    const id = await mk(st, null);
    assert.match((await sendNow(await actor(creator), s.companyId, id)).error!, /Only a scheduled/);
  }
  const notMine = await mk("scheduled", null);
  assert.match((await sendNow(await actor(other), s.companyId, notMine)).error!, /not found/); // not the creator, no send_now
});

test("sendTest: only to me, [Test], nothing recorded", async () => {
  const id = await mk("scheduled", null);
  const sent: { to: string; subject: string }[] = [];
  const r = await sendTest(await actor(creator), s.companyId, id, { send: (async (m: { to: string; subject: string }) => void sent.push(m)) as never });
  assert.deepEqual(r, { sent: ["email"] });
  assert.deepEqual(sent, [{ ...sent[0], to: `${creator}@${s.domain}`, subject: "[Test] Weekly sync" }]);
  assert.equal((await q("select 1 from deliveries where reminder_id = $1", [id])).length, 0);
  assert.equal((await q("select 1 from reminder_occurrences where reminder_id = $1", [id])).length, 0);
  // Someone who can't see it can't test it.
  assert.match((await sendTest(await actor(other), s.companyId, id)).error!, /not found/);
});
