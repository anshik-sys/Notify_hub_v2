"use server";

import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { withTenant } from "@/db";
import { roles } from "@/db/schema";
import { can, isPermission } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { errorUrl } from "@/components/form";
import { isUuid } from "@/lib/validate";

const SYSTEM_NAMES = ["company admin", "member"];

async function requireRoleManager() {
  const member = await requireMember();
  if (!can(member.access, "roles.manage")) notFound();
  return member;
}

// Creates when the form has no id, updates otherwise.
export async function saveRole(formData: FormData) {
  const { companyId } = await requireRoleManager();
  const id = String(formData.get("id") ?? "");
  const back = id ? `/settings/roles/${id}` : "/settings/roles/new";
  if (id && !isUuid(id)) notFound();

  const name = String(formData.get("name") ?? "").trim();
  const permissions = [...new Set(formData.getAll("permissions").map(String))];
  if (!name || name.length > 50) redirect(errorUrl(back, "Role name must be 1–50 characters."));
  if (SYSTEM_NAMES.includes(name.toLowerCase())) redirect(errorUrl(back, `"${name}" is a built-in role name.`));
  if (!permissions.every(isPermission)) redirect(errorUrl(back, "Unknown permission."));

  let error: string | null = null;
  try {
    await withTenant(companyId, async (tx) => {
      if (!id) return tx.insert(roles).values({ companyId, name, permissions });
      // company_id in the where clause on top of RLS; RLS also makes system roles unwritable.
      const updated = await tx
        .update(roles)
        .set({ name, permissions })
        .where(and(eq(roles.id, id), eq(roles.companyId, companyId)))
        .returning({ id: roles.id });
      if (updated.length === 0) error = "That role can't be edited.";
    });
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code !== "23505") throw e;
    error = `A role named "${name}" already exists.`;
  }
  if (error) redirect(errorUrl(back, error));
  redirect("/settings/roles");
}

export async function deleteRole(formData: FormData) {
  const { companyId } = await requireRoleManager();
  const id = String(formData.get("id") ?? "");
  if (!isUuid(id)) notFound();
  // user_roles rows go with it (on delete cascade).
  const deleted = await withTenant(companyId, (tx) =>
    tx
      .delete(roles)
      .where(and(eq(roles.id, id), eq(roles.companyId, companyId)))
      .returning({ id: roles.id }),
  );
  if (deleted.length === 0) redirect(errorUrl(`/settings/roles/${id}`, "That role can't be deleted."));
  redirect("/settings/roles");
}
