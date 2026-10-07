"use server";

import { notFound, redirect } from "next/navigation";
import { errorUrl } from "@/components/form";
import { addComment, deleteComment, editComment } from "@/lib/comments";
import { requireMember } from "@/lib/session";
import { isUuid } from "@/lib/validate";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const mentionIds = (fd: FormData) => fd.getAll("mentions").map(String);

async function me() {
  const { user, companyId, access } = await requireMember();
  return { actor: { id: user.id, name: user.name, email: user.email, access }, companyId };
}

const back = (reminderId: string, q = "", anchor = "discussion") => `/reminders/${reminderId}${q}#${anchor}`;
const skippedNotice = (skipped: string[]) =>
  skipped.length
    ? `?notice=${encodeURIComponent(`${skipped.join(", ")} can't see this reminder, so ${skipped.length === 1 ? "wasn't" : "weren't"} notified.`)}`
    : "";

export async function postComment(fd: FormData) {
  const { actor, companyId } = await me();
  const reminderId = str(fd, "reminderId");
  const parentId = str(fd, "parentId") || null;
  if (!isUuid(reminderId) || (parentId && !isUuid(parentId))) notFound();
  const r = await addComment(actor, companyId, reminderId, { body: str(fd, "body"), parentId, mentionIds: mentionIds(fd) });
  if ("error" in r) redirect(errorUrl(`/reminders/${reminderId}`, r.error) + "#discussion");
  redirect(back(reminderId, skippedNotice(r.skipped), `comment-${r.id}`));
}

export async function editCommentAction(fd: FormData) {
  const { actor, companyId } = await me();
  const [commentId, reminderId] = [str(fd, "commentId"), str(fd, "reminderId")];
  if (!isUuid(commentId) || !isUuid(reminderId)) notFound();
  const r = await editComment(actor, companyId, commentId, { body: str(fd, "body"), mentionIds: mentionIds(fd) });
  if ("error" in r) redirect(errorUrl(`/reminders/${reminderId}`, r.error) + "#discussion");
  redirect(back(r.reminderId, skippedNotice(r.skipped), `comment-${commentId}`));
}

export async function deleteCommentAction(fd: FormData) {
  const { actor, companyId } = await me();
  const [commentId, reminderId] = [str(fd, "commentId"), str(fd, "reminderId")];
  if (!isUuid(commentId) || !isUuid(reminderId)) notFound();
  const r = await deleteComment(actor, companyId, commentId);
  if ("error" in r) redirect(errorUrl(`/reminders/${reminderId}`, r.error) + "#discussion");
  redirect(back(r.reminderId));
}
