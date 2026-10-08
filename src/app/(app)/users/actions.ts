"use server";

import { notFound, redirect } from "next/navigation";
import { createInvitation, revokeInvitation } from "@/lib/invitations";
import { can, type Permission } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { adminResetTwoFactor, erasePerson, setActive, setUserRoles } from "@/lib/users";
import { isUuid } from "@/lib/validate";
import { errorUrl } from "@/components/form";

async function requirePermission(permission: Permission) {
  const member = await requireMember();
  if (!can(member.access, permission)) notFound();
  return member;
}

export async function inviteUser(formData: FormData) {
  const { user, companyId, access } = await requirePermission("users.create");
  const email = String(formData.get("email") ?? "");
  const roleIds = formData.getAll("roles").map(String);
  const departmentIds = formData.getAll("departments").map(String);
  if (![...roleIds, ...departmentIds].every(isUuid)) notFound();
  const error = await createInvitation({ id: user.id, name: user.name, access }, companyId, email, roleIds, departmentIds);
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
  const roleIds = formData.getAll("roles").map(String);
  if (!roleIds.every(isUuid)) notFound();
  const error = await setUserRoles({ id: user.id, access }, companyId, userId, roleIds);
  redirect(error ? errorUrl(`/users/${userId}`, error) : `/users/${userId}?notice=Roles%20saved.`);
}

export async function toggleActive(formData: FormData) {
  const { user, companyId, access } = await requirePermission("users.activate");
  const userId = String(formData.get("userId"));
  const active = formData.get("active") === "true";
  const error = await setActive({ id: user.id, access }, companyId, userId, active);
  redirect(error ? errorUrl(`/users/${userId}`, error) : `/users/${userId}`);
}

export async function resetTwoFactorAction(formData: FormData) {
  const { user, companyId, access } = await requirePermission("users.edit");
  const userId = String(formData.get("userId"));
  const error = await adminResetTwoFactor({ id: user.id, access }, companyId, userId);
  redirect(error ? errorUrl(`/users/${userId}`, error) : `/users/${userId}?notice=${encodeURIComponent("Two-factor reset. They've been signed out and can set it up again.")}`);
}

export async function erasePersonAction(formData: FormData) {
  const { user, companyId, access } = await requirePermission("users.delete");
  const userId = String(formData.get("userId"));
  const error = await erasePerson({ id: user.id, access }, companyId, userId);
  redirect(error ? errorUrl(`/users/${userId}`, error) : `/users?notice=${encodeURIComponent("Erased. Their personal data is gone; company records show “Deleted person”.")}`);
}
