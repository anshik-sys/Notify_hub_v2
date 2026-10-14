import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { addMember, createDepartment, deleteDepartment, getDepartment, listDepartments, removeMember, renameDepartment, setManager } from "./departments";
import { ALL_PERMISSIONS, COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { seeder } from "./test-helpers";

const s = seeder();
const other = seeder();
const admin = { id: "admin", access: { permissions: new Set(ALL_PERMISSIONS), managedDepartments: new Set<string>() } };

before(async () => {
  await s.company();
  await other.company();
});
after(async () => {
  await s.cleanup();
  await other.cleanup();
  await db.$client.end();
});

test("departments", async () => {
  const c = s.companyId;
  assert.equal(await createDepartment(c, "  Ops "), null);
  assert.match((await createDepartment(c, "Ops"))!, /already taken/);
  assert.match((await createDepartment(c, " "))!, /1–100/);
  const [ops] = await listDepartments(c);
  assert.deepEqual([ops.name, ops.members], ["Ops", 0]);
  assert.equal(await renameDepartment(c, ops.id, "Operations"), null);

  const alice = await s.user({ roles: [MEMBER_ROLE_ID] });
  const stranger = await other.user();
  const gone = await s.user();
  await s.owner.query(`update "user" set deactivated_at = now() where id = $1`, [gone]);

  assert.equal(await addMember(admin, c, ops.id, alice), null);
  assert.match((await addMember(admin, c, ops.id, alice))!, /Already a member/);
  assert.match((await addMember(admin, c, ops.id, stranger))!, /User not found/);
  assert.match((await addMember(admin, c, ops.id, gone))!, /deactivated/);
  // Another company's department is invisible.
  assert.match((await addMember(admin, other.companyId, ops.id, stranger))!, /Department not found/);

  assert.match((await setManager(c, ops.id, gone, true))!, /Only members/);
  assert.equal(await setManager(c, ops.id, alice, true), null);
  assert.deepEqual([...(await loadAccess(c, alice)).managedDepartments], [ops.id]);

  const dept = await getDepartment(c, ops.id);
  assert.deepEqual(dept!.members.map((m) => [m.id, m.isManager]), [[alice, true]]);
  assert.ok(!dept!.candidates.some((u) => u.id === alice || u.id === gone));

  // Removing drops the manager flag with the row.
  assert.equal(await removeMember(c, ops.id, alice), null);
  assert.equal((await loadAccess(c, alice)).managedDepartments.size, 0);

  await addMember(admin, c, ops.id, alice);
  assert.equal(await deleteDepartment(c, ops.id), null);
  assert.equal((await s.owner.query("select 1 from department_members where department_id = $1", [ops.id])).rowCount, 0);
  assert.match((await deleteDepartment(c, ops.id))!, /not found/);
});

test("a manager can't add someone above them to their department", async () => {
  const c = s.companyId;
  await createDepartment(c, "Sales");
  const sales = (await listDepartments(c)).find((d) => d.name === "Sales")!;
  const [mgr, peer, boss] = [await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] })];
  await addMember(admin, c, sales.id, mgr);
  await setManager(c, sales.id, mgr, true);
  const manager = { id: mgr, access: await loadAccess(c, mgr) };
  const isIn = async (u: string) => (await s.owner.query("select 1 from department_members where department_id = $1 and user_id = $2", [sales.id, u])).rowCount === 1;

  assert.match((await addMember(manager, c, sales.id, boss))!, /can't add someone with the Company Admin role/);
  assert.equal(await isIn(boss), false);
  // A custom role above the manager is refused too.
  const { rows } = await s.owner.query("insert into roles (company_id, name, permissions) values ($1, 'Auditors', '{audit.view}') returning id", [c]);
  const auditor = await s.user({ roles: [MEMBER_ROLE_ID, rows[0].id] });
  assert.match((await addMember(manager, c, sales.id, auditor))!, /Auditors role/);

  // Peers are fine; an admin can add anyone.
  assert.equal(await addMember(manager, c, sales.id, peer), null);
  assert.equal(await addMember(admin, c, sales.id, boss), null);
  assert.equal(await isIn(boss), true);
});
