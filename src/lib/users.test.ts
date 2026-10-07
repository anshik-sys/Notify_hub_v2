import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "./auth";
import { type Access, COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { seeder } from "./test-helpers";
import { listUsers, setActive, setUserRoles } from "./users";

const s = seeder();
let admin: { id: string; access: Access };

before(async () => {
  await s.company();
  const id = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID, MEMBER_ROLE_ID] });
  admin = { id, access: await loadAccess(s.companyId, id) };
});
after(async () => {
  await s.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

const rolesOf = async (id: string) =>
  (await s.owner.query("select role_id from user_roles where user_id = $1 order by role_id", [id])).rows.map((r) => r.role_id);

test("last admin can't be demoted or deactivated", async () => {
  assert.match((await setUserRoles(admin, s.companyId, admin.id, []))!, /at least one active Company Admin/);
  assert.deepEqual(await rolesOf(admin.id), [COMPANY_ADMIN_ROLE_ID, MEMBER_ROLE_ID]);

  const second = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  assert.match((await setActive(admin, s.companyId, admin.id, false))!, /yourself/);
  // With a second admin, demoting the first works; Member is always kept.
  assert.equal(await setUserRoles(admin, s.companyId, admin.id, []), null);
  assert.deepEqual(await rolesOf(admin.id), [MEMBER_ROLE_ID]);

  const secondAccess = { id: second, access: await loadAccess(s.companyId, second) };
  await s.owner.query("insert into user_roles (company_id, user_id, role_id) values ($1, $2, $3)", [s.companyId, admin.id, COMPANY_ADMIN_ROLE_ID]);
  // Two admins: one may deactivate the other; then the remaining one is the last.
  assert.equal(await setActive(secondAccess, s.companyId, admin.id, false), null);
  assert.match((await setUserRoles(secondAccess, s.companyId, second, []))!, /at least one active Company Admin/);
  assert.equal(await setActive(secondAccess, s.companyId, admin.id, true), null);
});

test("escalation: non-admins can't grant or act above themselves", async () => {
  await s.owner.query("insert into roles (company_id, name, permissions) values ($1, 'HR', '{users.view,users.manage_roles,users.activate}')", [s.companyId]);
  const hr = (await s.owner.query("select id from roles where company_id = $1 and name = 'HR'", [s.companyId])).rows[0].id;
  const hrUser = await s.user({ roles: [MEMBER_ROLE_ID, hr] });
  const hrActor = { id: hrUser, access: await loadAccess(s.companyId, hrUser) };
  const plain = await s.user({ roles: [MEMBER_ROLE_ID] });

  assert.match((await setUserRoles(hrActor, s.companyId, plain, [COMPANY_ADMIN_ROLE_ID]))!, /can't grant the Company Admin/);
  assert.equal(await setUserRoles(hrActor, s.companyId, plain, [hr]), null); // within own permissions
  assert.match((await setActive(hrActor, s.companyId, admin.id, false))!, /can't manage someone with the Company Admin/);
});

test("deactivating deletes sessions", async () => {
  const victim = await s.user({ roles: [MEMBER_ROLE_ID] });
  await s.owner.query("insert into session (id, expires_at, token, user_id, updated_at) values ($1, now() + interval '1 day', $1, $2, now())", [
    `s-${victim}`,
    victim,
  ]);
  assert.equal(await setActive(admin, s.companyId, victim, false), null);
  assert.equal((await s.owner.query("select 1 from session where user_id = $1", [victim])).rowCount, 0);
  assert.equal(await setActive(admin, s.companyId, victim, true), null);
  const { rows } = await s.owner.query(`select deactivated_at from "user" where id = $1`, [victim]);
  assert.equal(rows[0].deactivated_at, null);
});

test("directory: departments listed; search by name, email or department", async () => {
  const pat = await s.user();
  await s.owner.query(`update "user" set name = 'Pat Smith' where id = $1`, [pat]);
  const { rows } = await s.owner.query("insert into departments (company_id, name) values ($1, 'Field Ops') returning id", [s.companyId]);
  await s.owner.query("insert into department_members values ($1, $2, $3, true)", [s.companyId, rows[0].id, pat]);
  const ids = async (q: string) => (await listUsers(s.companyId, q)).users.map((u) => u.id);
  assert.deepEqual(await ids("field"), [pat]);
  assert.deepEqual(await ids("pat sm"), [pat]);
  assert.deepEqual(await ids("%"), []); // literal
  assert.deepEqual((await listUsers(s.companyId)).users.find((u) => u.id === pat)!.departments, [{ name: "Field Ops", isManager: true }]);
});
