import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { deleteRole, saveRole } from "./roles";
import { seeder } from "./test-helpers";

const s = seeder();
const role = async (name: string, permissions: string) =>
  (await s.owner.query("insert into roles (company_id, name, permissions) values ($1, $2, $3) returning id", [s.companyId, name, permissions])).rows[0].id as string;
const actor = async (roles: string[]) => {
  const id = await s.user({ roles: [MEMBER_ROLE_ID, ...roles] });
  return { id, access: await loadAccess(s.companyId, id) };
};

before(() => s.company());
after(async () => {
  await s.cleanup();
  await db.$client.end();
});

test("a role manager can't give a role permissions they don't have", async () => {
  const hr = await role("HR", "{roles.manage,users.view}");
  const hrActor = await actor([hr]);
  const other = await role("Viewers", "{users.view}");

  // The exploit: tick everything on their own role, then make themselves admin.
  assert.match((await saveRole(hrActor, s.companyId, hr, "HR", ["roles.manage", "users.view", "users.manage_roles"]))!, /permissions you have/);
  assert.match((await saveRole(hrActor, s.companyId, null, "Boss", ["users.manage_roles"]))!, /permissions you have/);
  assert.match((await saveRole(hrActor, s.companyId, other, "Viewers", ["users.view", "audit.view"]))!, /permissions you have/);
  const stored = await s.owner.query("select permissions from roles where id = $1", [hr]);
  assert.deepEqual(stored.rows[0].permissions, ["roles.manage", "users.view"]);

  // Within their own permissions, on roles they don't hold: allowed.
  assert.equal(await saveRole(hrActor, s.companyId, null, "Readers", ["users.view"]), null);
  assert.equal(await saveRole(hrActor, s.companyId, other, "Viewers 2", ["users.view"]), null);
  assert.equal(await deleteRole(hrActor, s.companyId, other), null);
});

test("a role manager can't change or delete a role above them", async () => {
  const hrActor = await actor([await role("HR2", "{roles.manage}")]);
  const senior = await role("Senior", "{roles.manage,audit.view}");
  assert.match((await saveRole(hrActor, s.companyId, senior, "Senior", ["roles.manage"]))!, /don't have/);
  assert.match((await deleteRole(hrActor, s.companyId, senior))!, /don't have/);
});

test("admins can change any custom role, never a system one", async () => {
  const admin = await actor([COMPANY_ADMIN_ROLE_ID]);
  const r = await role("Ops", "{audit.view}");
  assert.equal(await saveRole(admin, s.companyId, r, "Ops", ["audit.view", "reports.view"]), null);
  assert.equal(await deleteRole(admin, s.companyId, r), null);
  assert.match((await saveRole(admin, s.companyId, COMPANY_ADMIN_ROLE_ID, "X", []))!, /can't be edited/);
});
