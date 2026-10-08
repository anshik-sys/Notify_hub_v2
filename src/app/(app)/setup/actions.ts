"use server";

import { notFound, redirect } from "next/navigation";
import { errorUrl } from "@/components/form";
import { addMember, setManager } from "@/lib/departments";
import { createInvitation } from "@/lib/invitations";
import { can, MEMBER_ROLE_ID, type Permission } from "@/lib/permissions";
import { limits } from "@/lib/rate-limit";
import { requireMember } from "@/lib/session";
import { createDepartments, dismissSetup, parseLines } from "@/lib/setup";
import { isUuid } from "@/lib/validate";

// The guided setup's quick actions (PRD 3.1). Each needs company.edit plus
// the permission the normal page would need, and reuses the normal libs.
async function admin(also: Permission) {
  const m = await requireMember();
  if (!can(m.access, "company.edit") || !can(m.access, also)) notFound();
  return m;
}
const back = (notice: string, error?: string): never =>
  redirect(error ? errorUrl("/setup", error) : `/setup?notice=${encodeURIComponent(notice)}`);

export async function addDepartmentsAction(fd: FormData) {
  const { companyId } = await admin("departments.create");
  const r = await createDepartments(companyId, String(fd.get("names") ?? ""));
  if (!r.created.length && !r.skipped.length) back("", "Type at least one department name.");
  back([r.created.length ? `Created ${r.created.join(", ")}.` : "", r.skipped.length ? `Skipped ${r.skipped.join(", ")}.` : ""].join(" ").trim());
}

export async function invitePeopleAction(fd: FormData) {
  const { user, companyId, access } = await admin("users.create");
  const limited = await limits([[`setup-invite:${user.id}`, 20, 3600]]);
  if (limited) back("", limited);
  const dept = String(fd.get("departmentId") ?? "");
  if (dept && !isUuid(dept)) notFound();
  const emails = parseLines(String(fd.get("emails") ?? "").replace(/[,;]/g, "\n"), 25);
  if (!emails.length) back("", "Type at least one email.");
  const ok: string[] = [];
  const problems: string[] = [];
  for (const email of emails) {
    const error = await createInvitation({ id: user.id, name: user.name, access }, companyId, email, [MEMBER_ROLE_ID], dept ? [dept] : []);
    if (error) problems.push(`${email}: ${error}`);
    else ok.push(email);
  }
  back(ok.length ? `Invited ${ok.join(", ")}.` : "", problems.length ? problems.join(" ") : undefined);
}

// Any active person can be picked; they're added to the department first.
export async function setManagerAction(fd: FormData) {
  const { companyId } = await admin("departments.edit");
  const [dept, userId] = [String(fd.get("departmentId") ?? ""), String(fd.get("userId") ?? "")];
  if (!isUuid(dept) || !userId || userId.length > 64) notFound();
  const added = await addMember(companyId, dept, userId);
  if (added && added !== "Already a member.") back("", added);
  const error = await setManager(companyId, dept, userId, true);
  back("Manager set.", error ?? undefined);
}

export async function dismissSetupAction() {
  const { companyId } = await admin("company.edit");
  await dismissSetup(companyId);
  redirect("/");
}
