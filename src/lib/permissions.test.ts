import assert from "node:assert/strict";
import { test } from "node:test";
import { can, type Access, type Permission } from "./permissions";

const access = (permissions: Permission[], managed: string[] = []): Access => ({
  permissions: new Set(permissions),
  managedDepartments: new Set(managed),
});

test("can", () => {
  const member = access(["reminders.view"], ["d1"]);
  assert.equal(can(member, "reminders.view"), true); // company-wide
  assert.equal(can(member, "departments.manage_members", "d1"), true); // manager, own department
  assert.equal(can(member, "departments.manage_members", "d2"), false); // manager, other department
  assert.equal(can(member, "departments.manage_members"), false); // manager perm needs a department
  assert.equal(can(member, "roles.manage", "d1"), false); // not a manager permission
  assert.equal(can(access(["roles.manage"]), "roles.manage", "d9"), true); // company-wide covers any department
});
