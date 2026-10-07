"use server";

import { notFound, redirect } from "next/navigation";
import { errorUrl } from "@/components/form";
import { addGroupMembers, createGroup, deleteGroup, removeGroupMember, renameGroup } from "@/lib/groups";
import { requireMember } from "@/lib/session";
import { isUuid } from "@/lib/validate";

// Edit rights (creator or groups.manage) are checked in src/lib/groups.ts.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
async function actor(fd: FormData) {
  const id = str(fd, "groupId");
  if (!isUuid(id)) notFound();
  const { user, companyId, access } = await requireMember();
  return { id, companyId, actor: { id: user.id, access } };
}
const done = (path: string, error: string | null, notice?: string): never =>
  redirect(error ? errorUrl(path, error) : notice ? `${path}?notice=${encodeURIComponent(notice)}` : path);

export async function createGroupAction(fd: FormData) {
  const { user, companyId, access } = await requireMember();
  const r = await createGroup({ id: user.id, access }, companyId, str(fd, "name"));
  if ("error" in r) done("/groups", r.error);
  else redirect(`/groups/${r.id}`);
}

export async function renameGroupAction(fd: FormData) {
  const { id, companyId, actor: a } = await actor(fd);
  done(`/groups/${id}`, await renameGroup(a, companyId, id, str(fd, "name")), "Renamed.");
}

export async function deleteGroupAction(fd: FormData) {
  const { id, companyId, actor: a } = await actor(fd);
  const error = await deleteGroup(a, companyId, id);
  done(error ? `/groups/${id}` : "/groups", error, "Group deleted.");
}

export async function addGroupMembersAction(fd: FormData) {
  const { id, companyId, actor: a } = await actor(fd);
  // User ids are text (Better Auth), not uuids; unknown ones match nothing.
  const userIds = fd.getAll("users").map(String).filter((u) => u && u.length <= 64).slice(0, 500);
  const r = await addGroupMembers(a, companyId, id, userIds);
  if ("error" in r) done(`/groups/${id}`, r.error ?? null);
  const n = "needApproval" in r ? r.needApproval : 0;
  done(
    `/groups/${id}`,
    null,
    n ? `Added. ${n} upcoming reminder${n === 1 ? "" : "s"} to this group now need${n === 1 ? "s" : ""} approval because of who you added.` : "Added.",
  );
}

export async function removeGroupMemberAction(fd: FormData) {
  const { id, companyId, actor: a } = await actor(fd);
  const userId = str(fd, "userId");
  if (!userId || userId.length > 64) notFound();
  done(`/groups/${id}`, await removeGroupMember(a, companyId, id, userId), "Removed.");
}
