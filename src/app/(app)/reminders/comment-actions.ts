"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { errorUrl } from "@/components/form";
import { type CheckedFile, checkFile } from "@/lib/attachments";
import { addComment, deleteComment, editComment, MAX_FILES_PER_COMMENT } from "@/lib/comments";
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
// PRD 14.6 (CA1): checked like the reminder form's files, all before anything
// is saved; uploads share its hourly budget.
async function commentFiles(fd: FormData, userId: string, reminderId: string) {
  const uploads = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const fail = (message: string): never => redirect(errorUrl(`/reminders/${reminderId}`, message) + "#discussion");
  if (!uploads.length) return [];
  if (uploads.length > MAX_FILES_PER_COMMENT) fail(`A comment can have at most ${MAX_FILES_PER_COMMENT} files.`);
  const limited = await limits([[`upload:user:${userId}`, 30, 3600]]);
  if (limited) fail(limited);
  const files: CheckedFile[] = [];
  for (const u of uploads) {
    const checked = checkFile(u.name, new Uint8Array(await u.arrayBuffer()));
    if ("error" in checked) fail(checked.error);
    else files.push(checked.file);
  }
  return files;
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
  const files = await commentFiles(fd, actor.id, reminderId);
  const r = await addComment(actor, companyId, reminderId, { body: str(fd, "body"), parentId, mentionIds: mentionIds(fd), files });
  if ("error" in r) redirect(errorUrl(`/reminders/${reminderId}`, r.error) + "#discussion");
  back(reminderId, skippedNotice(r.skipped), `comment-${r.id}`);
}

export async function editCommentAction(fd: FormData) {
  const { actor, companyId } = await me();
  const [commentId, reminderId] = [str(fd, "commentId"), str(fd, "reminderId")];
  if (!isUuid(commentId) || !isUuid(reminderId)) notFound();
  await commentLimit(actor.id, reminderId);
  const removeFileIds = fd.getAll("removeFiles").map(String);
  if (!removeFileIds.every(isUuid)) notFound();
  const files = await commentFiles(fd, actor.id, reminderId);
  const r = await editComment(actor, companyId, commentId, { body: str(fd, "body"), mentionIds: mentionIds(fd), files, removeFileIds });
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
