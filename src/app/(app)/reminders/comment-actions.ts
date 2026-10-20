"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { errorUrl } from "@/components/form";
import { addComment, deleteComment, editComment } from "@/lib/comments";
import { limits } from "@/lib/rate-limit";
import { requireMember } from "@/lib/session";
import { isUuid, str } from "@/lib/validate";

const mentionIds = (fd: FormData) => fd.getAll("mentions").map(String);

async function me() {
  const { user, companyId, access } = await requireMember();
  return { actor: { id: user.id, name: user.name, email: user.email, access }, companyId };
}

// Posting and editing both notify mentions, so they share one budget.
async function commentLimit(userId: string, reminderId: string) {
  const limited = await limits([[`comment:user:${userId}`, 30, 3600]]);
  if (limited) redirect(errorUrl(`/reminders/${reminderId}`, limited) + "#discussion");
}

// Back to the reminder. Usually only the #anchor differs from the current URL,
// which the router treats as a scroll and keeps the old page, so mark it stale.
function back(reminderId: string, q = "", anchor = "discussion"): never {
  revalidatePath(`/reminders/${reminderId}`);
  redirect(`/reminders/${reminderId}${q}#${anchor}`);
}
const skippedNotice = (skipped: string[]) =>
  skipped.length
    ? `?notice=${encodeURIComponent(`${skipped.join(", ")} can't see this reminder, so ${skipped.length === 1 ? "wasn't" : "weren't"} notified.`)}`
    : "";

export async function postComment(fd: FormData) {
  const { actor, companyId } = await me();
  const reminderId = str(fd, "reminderId");
  const parentId = str(fd, "parentId") || null;
  if (!isUuid(reminderId) || (parentId && !isUuid(parentId))) notFound();
  await commentLimit(actor.id, reminderId);
  const r = await addComment(actor, companyId, reminderId, { body: str(fd, "body"), parentId, mentionIds: mentionIds(fd) });
  if ("error" in r) redirect(errorUrl(`/reminders/${reminderId}`, r.error) + "#discussion");
  back(reminderId, skippedNotice(r.skipped), `comment-${r.id}`);
}

export async function editCommentAction(fd: FormData) {
  const { actor, companyId } = await me();
  const [commentId, reminderId] = [str(fd, "commentId"), str(fd, "reminderId")];
  if (!isUuid(commentId) || !isUuid(reminderId)) notFound();
  await commentLimit(actor.id, reminderId);
  const r = await editComment(actor, companyId, commentId, { body: str(fd, "body"), mentionIds: mentionIds(fd) });
  if ("error" in r) redirect(errorUrl(`/reminders/${reminderId}`, r.error) + "#discussion");
  back(r.reminderId, skippedNotice(r.skipped), `comment-${commentId}`);
}

export async function deleteCommentAction(fd: FormData) {
  const { actor, companyId } = await me();
  const [commentId, reminderId] = [str(fd, "commentId"), str(fd, "reminderId")];
  if (!isUuid(commentId) || !isUuid(reminderId)) notFound();
  const r = await deleteComment(actor, companyId, commentId);
  if ("error" in r) redirect(errorUrl(`/reminders/${reminderId}`, r.error) + "#discussion");
  back(r.reminderId);
}
