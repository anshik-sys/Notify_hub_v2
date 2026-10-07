import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { departmentMembers, roles, userRoles } from "@/db/schema";

// The permission catalogue (PRD 2.1). Adding a key here is all it takes to
// make it assignable; enforcing it is up to the code that calls can().
export const PERMISSION_GROUPS = {
  Reminders: {
    "reminders.create": "Create",
    "reminders.view": "View",
    "reminders.edit": "Edit",
    "reminders.delete": "Delete",
    "reminders.send_now": "Send now",
    "reminders.view_all": "View all in company",
    "reminders.approve": "Approve out-of-scope sends",
  },
  Users: {
    "users.create": "Create",
    "users.view": "View",
    "users.edit": "Edit",
    "users.delete": "Delete",
    "users.activate": "Activate / deactivate",
    "users.manage_roles": "Assign roles",
  },
  "Departments and groups": {
    "departments.create": "Create",
    "departments.view": "View",
    "departments.edit": "Edit",
    "departments.delete": "Delete",
    "departments.manage_members": "Add and remove members",
  },
  Company: {
    "company.view": "View settings",
    "company.edit": "Edit settings",
    "company.manage_domains": "Manage domains",
    "company.manage_integrations": "Manage integrations",
  },
  Reports: {
    "reports.view": "View",
    "reports.export": "Export",
  },
  Settings: {
    "roles.manage": "Manage roles and permissions",
  },
} as const;

type Groups = typeof PERMISSION_GROUPS;
export type Permission = { [G in keyof Groups]: keyof Groups[G] }[keyof Groups];
export const ALL_PERMISSIONS = Object.values(PERMISSION_GROUPS).flatMap((g) => Object.keys(g)) as Permission[];
export const isPermission = (p: string): p is Permission => (ALL_PERMISSIONS as string[]).includes(p);

// System roles, seeded by migration 0004 with these fixed ids.
export const COMPANY_ADMIN_ROLE_ID = "00000000-0000-4000-8000-000000000001";
export const MEMBER_ROLE_ID = "00000000-0000-4000-8000-000000000002";

// A department manager gets these, but only for the departments they manage.
// ponytail: fixed in code; make it an editable department-scoped role if customers ask
export const MANAGER_PERMISSIONS: readonly Permission[] = [
  "departments.view",
  "departments.manage_members",
  "users.view",
  "reminders.create",
  "reminders.view",
  "reminders.edit",
  "reminders.delete",
  "reminders.send_now",
];

export type Access = { permissions: ReadonlySet<Permission>; managedDepartments: ReadonlySet<string> };

// Company-wide permissions always apply. Manager permissions apply only when
// the check names a department the user manages.
export function can(access: Access, permission: Permission, departmentId?: string) {
  if (access.permissions.has(permission)) return true;
  return departmentId !== undefined && access.managedDepartments.has(departmentId) && MANAGER_PERMISSIONS.includes(permission);
}

export async function loadAccess(companyId: string, userId: string): Promise<Access> {
  return withTenant(companyId, async (tx) => {
    const held = await tx
      .select({ id: roles.id, permissions: roles.permissions })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId));
    const managed = await tx
      .select({ id: departmentMembers.departmentId })
      .from(departmentMembers)
      .where(and(eq(departmentMembers.userId, userId), eq(departmentMembers.isManager, true)));
    // Company Admin is "everything", decided here rather than stored, so a new
    // catalogue key never needs a data migration. Its row holds '{}'.
    const isAdmin = held.some((r) => r.id === COMPANY_ADMIN_ROLE_ID);
    return {
      permissions: new Set(isAdmin ? ALL_PERMISSIONS : held.flatMap((r) => r.permissions).filter(isPermission)),
      managedDepartments: new Set(managed.map((m) => m.id)),
    };
  });
}

// Roles visible to a company: the system roles plus its own custom ones.
export const visibleRoles = (companyId: string) =>
  withTenant(companyId, (tx) => tx.select().from(roles).orderBy(roles.companyId, roles.name));


// Escalation rule: you may grant (or take away, or act on someone holding) a
// role only if you already hold every permission in it. Company Admin needs
// every permission, i.e. only admins make or unmake admins.
export function canGrant(access: Access, role: { id: string; permissions: string[] }) {
  if (role.id === COMPANY_ADMIN_ROLE_ID) return ALL_PERMISSIONS.every((p) => access.permissions.has(p));
  return role.permissions.every((p) => isPermission(p) && access.permissions.has(p));
}
