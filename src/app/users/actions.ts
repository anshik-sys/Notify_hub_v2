"use server";

import { notFound, redirect } from "next/navigation";
import { createInvitation, revokeInvitation } from "@/lib/invitations";
import { can, type Permission } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { setActive, setUserRoles } from "@/lib/users";
import { isUuid } from "@/lib/validate";
import { errorUrl } from "../form";

async function requirePermission(permission: Permission) {
  const member = await requireMember();
  if (!can(member.access, permission)) notFound();
  return member;
}

export async function inviteUser(formData: FormData) {
  const { user, companyId, access } = await requirePermission("users.create");
  const email = String(formData.get("email") ?? "");
  const roleIds = formData.getAll("roles").map(String);
  const error = await createInvitation({ id: user.id, name: user.name, access }, companyId, email, roleIds);
  if (error) redirect(errorUrl("/users/invite", error));
  redirect(`/users?notice=${encodeURIComponent(`Invite sent to ${email.trim().toLowerCase()}.`)}`);
}

export async function revokeInvite(formData: FormData) {
  const { companyId } = await requirePermission("users.create");
  const id = String(formData.get("id"));
  if (!isUuid(id)) notFound();
  await revokeInvitation(companyId, id);
  redirect("/users");
}

export async function saveUserRoles(formData: FormData) {
  const { user, companyId, access } = await requirePermission("users.manage_roles");
  const userId = String(formData.get("userId"));
  const error = await setUserRoles({ id: user.id, access }, companyId, userId, formData.getAll("roles").map(String));
  redirect(error ? errorUrl(`/users/${userId}`, error) : `/users/${userId}?notice=Roles%20saved.`);
}

export async function toggleActive(formData: FormData) {
  const { user, companyId, access } = await requirePermission("users.activate");
  const userId = String(formData.get("userId"));
  const active = formData.get("active") === "true";
  const error = await setActive({ id: user.id, access }, companyId, userId, active);
  redirect(error ? errorUrl(`/users/${userId}`, error) : `/users/${userId}`);
}
