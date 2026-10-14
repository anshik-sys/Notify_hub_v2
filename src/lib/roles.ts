import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { roles } from "@/db/schema";
import { type Access, canGrant, isPermission } from "./permissions";

type Actor = { id: string; access: Access };

const SYSTEM_NAMES = ["company admin", "member"];

// Escalation rule (canGrant) for custom roles: you can only put permissions
// you hold into a role, and only change or delete a role whose permissions you
// all hold. Otherwise roles.manage alone would let someone tick every box on
// their own role and then make themselves admin.
async function guard(actor: Actor, companyId: string, id: string | null, permissions: string[]) {
  if (!canGrant(actor.access, { id: "", permissions })) return "You can only give a role permissions you have yourself.";
  if (!id) return null;
  const [role] = await withTenant(companyId, (tx) =>
    tx.select().from(roles).where(and(eq(roles.id, id), eq(roles.companyId, companyId))),
  );
  // No role: the caller reports "can't be edited/deleted".
  return role && !canGrant(actor.access, role) ? "You can't change a role with permissions you don't have." : null;
}

// Creates when id is null, updates otherwise.
export async function saveRole(actor: Actor, companyId: string, id: string | null, name: string, permissions: string[]) {
  if (!name || name.length > 50) return "Role name must be 1–50 characters.";
  if (SYSTEM_NAMES.includes(name.toLowerCase())) return `"${name}" is a built-in role name.`;
  if (!permissions.every(isPermission)) return "Unknown permission.";
  const refused = await guard(actor, companyId, id, permissions);
  if (refused) return refused;
  try {
    return await withTenant(companyId, async (tx) => {
      if (!id) {
        await tx.insert(roles).values({ companyId, name, permissions });
        return null;
      }
      // company_id in the where clause on top of RLS; RLS also makes system roles unwritable.
      const updated = await tx
        .update(roles)
        .set({ name, permissions })
        .where(and(eq(roles.id, id), eq(roles.companyId, companyId)))
        .returning({ id: roles.id });
      return updated.length ? null : "That role can't be edited.";
    });
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code !== "23505") throw e;
    return `A role named "${name}" already exists.`;
  }
}

export async function deleteRole(actor: Actor, companyId: string, id: string) {
  const refused = await guard(actor, companyId, id, []);
  if (refused) return refused;
  // user_roles rows go with it (on delete cascade).
  const deleted = await withTenant(companyId, (tx) =>
    tx
      .delete(roles)
      .where(and(eq(roles.id, id), eq(roles.companyId, companyId)))
      .returning({ id: roles.id }),
  );
  return deleted.length ? null : "That role can't be deleted.";
}
