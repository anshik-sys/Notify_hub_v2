"use server";

import { notFound, redirect } from "next/navigation";
import {
  addMember,
  createDepartment,
  deleteDepartment,
  removeMember,
  renameDepartment,
  setManager,
} from "@/lib/departments";
import { can, type Permission } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { isUserId, isUuid } from "@/lib/validate";
import { errorUrl } from "@/components/form";

// departmentId given: manager permissions count for departments the user manages.
async function requirePermission(permission: Permission, departmentId?: string) {
  if (departmentId !== undefined && !isUuid(departmentId)) notFound();
  const member = await requireMember();
  if (!can(member.access, permission, departmentId)) notFound();
  return member;
}

const userIdFrom = (formData: FormData) => {
  const id = String(formData.get("userId"));
  return isUserId(id) ? id : notFound();
};
const done = (path: string, error: string | null): never => redirect(error ? errorUrl(path, error) : path);

export async function createDepartmentAction(formData: FormData) {
  const { companyId } = await requirePermission("departments.create");
  done("/departments", await createDepartment(companyId, String(formData.get("name") ?? "")));
}

// Admin-only actions check without a department, so manager permissions never apply.
export async function renameDepartmentAction(formData: FormData) {
  const id = String(formData.get("departmentId"));
  if (!isUuid(id)) notFound();
  const { companyId } = await requirePermission("departments.edit");
  done(`/departments/${id}`, await renameDepartment(companyId, id, String(formData.get("name") ?? "")));
}

export async function deleteDepartmentAction(formData: FormData) {
  const id = String(formData.get("departmentId"));
  if (!isUuid(id)) notFound();
  const { companyId } = await requirePermission("departments.delete");
  const error = await deleteDepartment(companyId, id);
  done(error ? `/departments/${id}` : "/departments", error);
}

export async function setManagerAction(formData: FormData) {
  const id = String(formData.get("departmentId"));
  if (!isUuid(id)) notFound();
  const { companyId } = await requirePermission("departments.edit");
  const isManager = formData.get("isManager") === "true";
  done(`/departments/${id}`, await setManager(companyId, id, userIdFrom(formData), isManager));
}

export async function addMemberAction(formData: FormData) {
  const id = String(formData.get("departmentId"));
  const { user, companyId, access } = await requirePermission("departments.manage_members", id);
  done(`/departments/${id}`, await addMember({ id: user.id, access }, companyId, id, userIdFrom(formData)));
}

export async function removeMemberAction(formData: FormData) {
  const id = String(formData.get("departmentId"));
  const { companyId } = await requirePermission("departments.manage_members", id);
  done(`/departments/${id}`, await removeMember(companyId, id, userIdFrom(formData)));
}
