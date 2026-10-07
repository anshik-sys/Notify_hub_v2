import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { addMember, createDepartment, deleteDepartment, getDepartment, listDepartments, removeMember, renameDepartment, setManager } from "./departments";
import { loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { seeder } from "./test-helpers";

const s = seeder();
const other = seeder();

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

  assert.equal(await addMember(c, ops.id, alice), null);
  assert.match((await addMember(c, ops.id, alice))!, /Already a member/);
  assert.match((await addMember(c, ops.id, stranger))!, /User not found/);
  assert.match((await addMember(c, ops.id, gone))!, /deactivated/);
  // Another company's department is invisible.
  assert.match((await addMember(other.companyId, ops.id, stranger))!, /Department not found/);

  assert.match((await setManager(c, ops.id, gone, true))!, /Only members/);
  assert.equal(await setManager(c, ops.id, alice, true), null);
  assert.deepEqual([...(await loadAccess(c, alice)).managedDepartments], [ops.id]);

  const dept = await getDepartment(c, ops.id);
  assert.deepEqual(dept!.members.map((m) => [m.id, m.isManager]), [[alice, true]]);
  assert.ok(!dept!.candidates.some((u) => u.id === alice || u.id === gone));

  // Removing drops the manager flag with the row.
  assert.equal(await removeMember(c, ops.id, alice), null);
  assert.equal((await loadAccess(c, alice)).managedDepartments.size, 0);

  await addMember(c, ops.id, alice);
  assert.equal(await deleteDepartment(c, ops.id), null);
  assert.equal((await s.owner.query("select 1 from department_members where department_id = $1", [ops.id])).rowCount, 0);
  assert.match((await deleteDepartment(c, ops.id))!, /not found/);
});
