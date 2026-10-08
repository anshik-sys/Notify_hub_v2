import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { purgeCompany } from "./retention";

const s = seeder();
const other = seeder();
let alice: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const mk = async (company: string, status: string, ageDays: number) =>
  (
    await s.owner.query(
      `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, updated_at)
       values ($1, $2, $3, $4, 'S', '2030-01-01T09:00Z', $5, 'UTC', '2030-01-01T09:00', now() - make_interval(days => $6)) returning id`,
      [company, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, alice, `${status}-${ageDays}`, status, ageDays],
    )
  ).rows[0].id as string;

before(async () => {
  await s.company();
  await other.company();
  alice = await s.user();
});
after(async () => {
  await other.cleanup(); // its reminder was created by alice (s)
  await s.cleanup();
  await ownerDb.$client.end();
});

test("purges finished history past the period, keeps the rest, records itself", async () => {
  const oldSent = await mk(s.companyId, "sent", 200);
  await mk(s.companyId, "cancelled", 200);
  await mk(s.companyId, "rejected", 200);
  await mk(s.companyId, "sent", 10); // recent
  await mk(s.companyId, "scheduled", 400); // upcoming: never
  await mk(s.companyId, "paused", 400);
  const theirs = await mk(other.companyId, "sent", 200); // another company with no retention set
  const [{ id: occ }] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now(), 'sent') returning id", [s.companyId, oldSent]);
  await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, status) values ($1, $2, $3, 'x@y.z', 'sent')", [s.companyId, oldSent, occ]);
  await q("insert into notifications (company_id, user_id, kind, text, created_at) values ($1, $2, 'reminder', 'old', now() - interval '200 days'), ($1, $2, 'reminder', 'new', now())", [s.companyId, alice]);
  await q("insert into audit_log (company_id, action, object_type, changes, at) values ($1, 'create', 'x', '{}', now() - interval '200 days'), ($1, 'create', 'x', '{}', now())", [s.companyId]);

  assert.deepEqual(await purgeCompany(s.companyId, 90), { reminders: 3, notifications: 1, audit: 1, people: 0 });
  const left = (await q("select title from reminders where company_id = $1 order by title", [s.companyId])).map((r) => r.title);
  assert.deepEqual(left, ["paused-400", "scheduled-400", "sent-10"]);
  assert.equal((await q("select 1 from deliveries where reminder_id = $1", [oldSent])).length, 0); // cascaded
  assert.deepEqual((await q("select text from notifications where company_id = $1", [s.companyId])).map((r) => r.text), ["new"]);
  const audit = await q("select actor_name, object_type, changes from audit_log where company_id = $1 and object_type = 'retention'", [s.companyId]);
  assert.deepEqual(audit, [{ actor_name: "System", object_type: "retention", changes: { reminders: 3, notifications: 1, audit_entries: 1, people_erased: 0 } }]);
  assert.equal((await q("select 1 from reminders where id = $1", [theirs])).length, 1);
  assert.deepEqual(await purgeCompany(s.companyId, 90), { reminders: 0, notifications: 0, audit: 0, people: 0 }); // nothing left: no new audit row
});

test("people deactivated longer than the period are erased", async () => {
  const [oldGone, recentGone] = [await s.user(), await s.user()];
  await q(`update "user" set name = 'Old Gone', deactivated_at = now() - interval '200 days' where id = $1`, [oldGone]);
  await q(`update "user" set name = 'Recent Gone', deactivated_at = now() - interval '10 days' where id = $1`, [recentGone]);
  const r = await purgeCompany(s.companyId, 90);
  assert.equal(r.people, 1);
  const rows = await q(`select id, name, erased_at is not null as erased from "user" where id = any($1) order by name`, [[oldGone, recentGone]]);
  assert.deepEqual(rows.map((x) => [x.name, x.erased]), [["Deleted person", true], ["Recent Gone", false]]);
  const [row] = await q("select changes from audit_log where company_id = $1 and object_type = 'retention' order by id desc limit 1", [s.companyId]);
  assert.equal(row.changes.people_erased, 1);
});
