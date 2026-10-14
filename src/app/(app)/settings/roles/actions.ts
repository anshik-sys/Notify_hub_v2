"use server";

import { notFound, redirect } from "next/navigation";
import { can } from "@/lib/permissions";
import { deleteRole as removeRole, saveRole as storeRole } from "@/lib/roles";
import { requireMember } from "@/lib/session";
import { errorUrl } from "@/components/form";
import { isUuid } from "@/lib/validate";

async function requireRoleManager() {
  const member = await requireMember();
  if (!can(member.access, "roles.manage")) notFound();
  return { actor: { id: member.user.id, access: member.access }, companyId: member.companyId };
}

// Creates when the form has no id, updates otherwise.
export async function saveRole(formData: FormData) {
  const { actor, companyId } = await requireRoleManager();
  const id = String(formData.get("id") ?? "");
  const back = id ? `/settings/roles/${id}` : "/settings/roles/new";
  if (id && !isUuid(id)) notFound();

  const name = String(formData.get("name") ?? "").trim();
  const permissions = [...new Set(formData.getAll("permissions").map(String))];
  const error = await storeRole(actor, companyId, id || null, name, permissions);
  if (error) redirect(errorUrl(back, error));
  redirect("/settings/roles");
}

export async function deleteRole(formData: FormData) {
  const { actor, companyId } = await requireRoleManager();
  const id = String(formData.get("id") ?? "");
  if (!isUuid(id)) notFound();
  const error = await removeRole(actor, companyId, id);
  if (error) redirect(errorUrl(`/settings/roles/${id}`, error));
  redirect("/settings/roles");
}
