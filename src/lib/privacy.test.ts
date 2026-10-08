import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { departmentMembers, user } from "@/db/schema";
import { authDb } from "./auth";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { exportPerson } from "./privacy";
import { seeder } from "./test-helpers";
import { erasePerson } from "./users";

const s = seeder();
const other = seeder();
let admin: string, member: string, bob: string, ops: string, created: string, received: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const actor = async (id: string) => ({ id, access: await loadAccess(s.companyId, id) });
let bobEmail = "";

before(async () => {
  await s.company();
  await other.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  member = await s.user({ roles: [MEMBER_ROLE_ID] });
  bob = await s.user({ roles: [MEMBER_ROLE_ID], email: `bob-${Date.now()}@${s.domain}` });
  bobEmail = (await q(`select email from "user" where id = $1`, [bob]))[0].email;
  await q(`update "user" set name = 'Bobby Tables' where id = $1`, [bob]);
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  // Audited actions about bob, made by the admin (so the audit log holds his name).
  await withTenant(s.companyId, (tx) => tx.insert(departmentMembers).values({ companyId: s.companyId, departmentId: ops, userId: bob, isManager: false }), admin);
  await withTenant(s.companyId, (tx) => tx.update(user).set({ timeZone: "Asia/Dubai" }).where(eq(user.id, bob)), admin);
  const [{ id: g }] = await q("insert into groups (company_id, name) values ($1, 'Night') returning id", [s.companyId]);
  await q("insert into group_members values ($1, $2, $3)", [g, s.companyId, bob]);
  const mk = async (by: string, title: string, status: string) =>
    (
      await q(
        `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local)
         values ($1, $2, $3, $4, 'S', now() + interval '1 day', $5, 'UTC', '2030-01-01T00:00') returning id`,
        [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, by, title, status],
      )
    )[0].id as string;
  created = await mk(bob, "Bob's weekly", "scheduled");
  received = await mk(admin, "To bob", "sent");
  await q("insert into reminder_targets values ($1, $2, 'email', $3, null)", [received, s.companyId, bobEmail]);
  const [{ id: occ }] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now(), 'sent') returning id", [s.companyId, received]);
  await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id, status) values ($1, $2, $3, $4, $5, 'sent')", [s.companyId, received, occ, bobEmail, bob]);
  await withTenant(s.companyId, (tx) => tx.execute(`insert into comments (company_id, reminder_id, author_id, body) values ('${s.companyId}', '${received}', '${bob}', 'Bobby here, call me')` as never), bob);
  await q("insert into session (id, expires_at, token, user_id, updated_at, user_agent) values ($1, now() + interval '1 day', $1, $2, now(), 'Firefox')", [`s-${bob}`, bob]);
  await q("insert into account (id, account_id, provider_id, user_id, password, updated_at) values ($1, $2, 'credential', $2, 'hash', now())", [`a-${bob}`, bob]);
  await q("insert into two_factor (id, secret, backup_codes, user_id) values ($1, 'enc', 'enc', $2)", [`t-${bob}`, bob]);
  await q("insert into invitations (company_id, email, role_ids, invited_by, token_hash, expires_at) values ($1, $2, '{}', $3, 'h', now() + interval '1 day')", [s.companyId, bobEmail, admin]);
});
after(async () => {
  await other.cleanup();
  await s.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

test("export: every section, no secrets", async () => {
  const data = await exportPerson(s.companyId, bob);
  assert.equal((data.profile as { email: string }).email, bobEmail);
  assert.deepEqual(data.departments, [{ name: "Ops", is_manager: false }]);
  assert.deepEqual(data.groups, [{ name: "Night" }]);
  assert.deepEqual(data.remindersCreated.map((r) => r.title), ["Bob's weekly"]);
  assert.deepEqual(data.comments.map((c) => c.body), ["Bobby here, call me"]);
  assert.deepEqual(data.deliveriesToThem.map((d) => d.reminder), ["To bob"]);
  assert.deepEqual(data.sessions.map((x) => x.userAgent), ["Firefox"]);
  const text = JSON.stringify(data);
  for (const k of ["token", "password", "secret", "backup_codes", "token_hash"]) assert.ok(!text.includes(`"${k}"`), k);
  assert.equal((await exportPerson(other.companyId, bob)).profile, undefined); // another company sees nothing
});

test("erase: refusals", async () => {
  assert.match((await erasePerson(await actor(admin), s.companyId, bob))!, /Deactivate them first/);
  await q(`update "user" set deactivated_at = now() where id = $1`, [bob]);
  assert.match((await erasePerson(await actor(member), s.companyId, bob))!, /can't erase/); // no users.delete
  assert.match((await erasePerson(await actor(admin), s.companyId, admin))!, /yourself/);
  // The SQL function itself refuses another company's context.
  await assert.rejects(
    withTenant(other.companyId, (tx) => tx.execute(`select erase_person('${bob}')` as never)),
    (e: unknown) => /not in this company/.test(String((e as { cause?: Error }).cause?.message ?? e)),
  );
});

test("erase: personal data gone, company records kept, audit scrubbed", async () => {
  assert.equal(await erasePerson(await actor(admin), s.companyId, bob), null);
  const [u] = await q(`select name, email, erased_at, time_zone, two_factor_enabled from "user" where id = $1`, [bob]);
  assert.equal(u.name, "Deleted person");
  assert.match(u.email, /@erased\.invalid$/);
  assert.ok(u.erased_at);
  for (const t of ["session", "account", "two_factor", "user_roles", "department_members", "group_members"])
    assert.equal((await q(`select 1 from ${t} where user_id = $1`, [bob])).length, 0, t);
  assert.deepEqual(await q("select body, deleted_at is not null as deleted from comments where author_id = $1", [bob]), [{ body: "", deleted: true }]);
  assert.deepEqual(await q("select address from deliveries where user_id = $1", [bob]), [{ address: "erased" }]);
  assert.equal((await q("select 1 from reminder_targets where kind = 'email' and lower(ref) = lower($1)", [bobEmail])).length, 0);
  assert.equal((await q("select 1 from invitations where email = $1", [bobEmail])).length, 0);
  assert.deepEqual(await q("select status from reminders where id = $1", [created]), [{ status: "scheduled" }]); // kept, still scheduled

  const audit = JSON.stringify(await q("select * from audit_log where company_id = $1", [s.companyId]));
  assert.ok(!audit.includes(bobEmail), "email in audit");
  assert.ok(!audit.includes("Bobby"), "name or comment text in audit");
  const last = await q("select actor_id, object_label, changes from audit_log where company_id = $1 and object_type = 'user' and object_id = $2 order by id desc limit 1", [s.companyId, bob]);
  assert.equal(last[0].actor_id, admin);
  assert.deepEqual(Object.keys(last[0].changes), ["erased_at"]);
  assert.match((await erasePerson(await actor(admin), s.companyId, bob))!, /Already erased/);
});
