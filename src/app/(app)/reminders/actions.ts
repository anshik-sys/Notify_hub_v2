"use server";

import { notFound, redirect } from "next/navigation";
import { errorUrl, safeNext } from "@/components/form";
import { type CheckedFile, checkFile, MAX_FILES_PER_SAVE } from "@/lib/attachments";
import { can } from "@/lib/permissions";
import {
  cancelReminder,
  createReminder,
  decideReminder,
  deleteReminder,
  detachOccurrence,
  formToRaw,
  setOccurrenceDone,
  pauseReminder,
  resumeReminder,
  skipNextOccurrence,
  updateReminder,
  validateInput,
} from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { senderDefault } from "@/lib/company";
import { limits } from "@/lib/rate-limit";
import { channelChoices } from "@/lib/slack-installations";
import { sendNow, sendTest } from "@/lib/send-now";
import { setDone } from "@/lib/tasks";
import { unsubscribedAmong } from "@/lib/unsubscribe";
import { isUuid, str } from "@/lib/validate";

const all = (fd: FormData, name: string) => fd.getAll(name).map(String);

// Creates when the form has no id, updates otherwise.
export async function saveReminder(fd: FormData) {
  const { user, companyId, company, access } = await requireMember();
  if (!can(access, "reminders.create")) notFound();
  const id = str(fd, "id");
  if (id && !isUuid(id)) notFound();
  const raw = formToRaw(fd);
  // "Only the next one" of a series: saved as a one-time reminder (detachOccurrence).
  const onlyNext = Boolean(id) && fd.get("scope") === "one";
  if (onlyNext) raw.repeat = { ...raw.repeat, repeat: "none" };
  if (![...raw.departmentIds, ...raw.groupIds, ...raw.shareDepartmentIds, ...raw.shareGroupIds].every(isUuid)) notFound();
  const back = id ? `/reminders/${id}/edit` : "/reminders/new";

  const parsed = validateInput(
    raw,
    company.timeZone,
    senderDefault(company),
    new Date(),
    // Only ask Slack for the channel list when the form uses Slack.
    raw.channels.includes("slack") || raw.slackChannelIds.length ? await channelChoices(companyId) : null,
  );
  if (parsed.error !== undefined) redirect(errorUrl(back, parsed.error));

  // Files: every one is checked (content, type, CSV formulas) before anything
  // is saved, so one bad file means nothing is written.
  const uploads = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (uploads.length) {
    const limited = await limits([[`upload:user:${user.id}`, 30, 3600]]);
    if (limited) redirect(errorUrl(back, limited));
  }
  if (uploads.length > MAX_FILES_PER_SAVE) redirect(errorUrl(back, `Attach at most ${MAX_FILES_PER_SAVE} files at a time.`));
  const files: CheckedFile[] = [];
  for (const u of uploads) {
    const checked = checkFile(u.name, new Uint8Array(await u.arrayBuffer()));
    if ("error" in checked) redirect(errorUrl(back, checked.error));
    files.push(checked.file);
  }
  const removeAttachmentIds = all(fd, "removeAttachments");
  if (!removeAttachmentIds.every(isUuid)) notFound();

  const me = { id: user.id, access };
  // Tell the sender now, before anything goes out, if a typed address unsubscribed.
  const gone = await unsubscribedAmong(companyId, parsed.input.targets.filter((t) => t.kind === "email").map((t) => t.ref!));
  const notice = gone.length
    ? `?notice=${encodeURIComponent(`${gone.join(", ")} unsubscribed from your company’s reminders and won’t receive this.`)}`
    : "";
  if (onlyNext) {
    const made = await detachOccurrence(me, companyId, id, parsed.input, files, removeAttachmentIds);
    if ("error" in made) redirect(errorUrl(back, made.error));
    redirect(`/reminders/${made.id}${notice || `?notice=${encodeURIComponent("Saved as a separate reminder. The series skips that date.")}`}`);
  }
  if (id) {
    const error = await updateReminder(me, companyId, id, parsed.input, files, removeAttachmentIds);
    if (error) redirect(errorUrl(back, error));
    redirect(`/reminders/${id}${notice}`);
  }
  const created = await createReminder(me, companyId, parsed.input, files);
  if ("error" in created) redirect(errorUrl(back, created.error));
  redirect(`/reminders/${created.id}${notice}`);
}

export async function cancelReminderAction(fd: FormData) {
  const { user, companyId, access } = await requireMember();
  const id = str(fd, "id");
  if (!isUuid(id)) notFound();
  const error = await cancelReminder({ id: user.id, access }, companyId, id);
  redirect(error ? errorUrl(`/reminders/${id}`, error) : `/reminders/${id}`);
}

export async function deleteReminderAction(fd: FormData) {
  const { user, companyId, access } = await requireMember();
  const id = str(fd, "id");
  if (!isUuid(id)) notFound();
  const error = await deleteReminder({ id: user.id, access }, companyId, id);
  if (error) redirect(errorUrl(`/reminders/${id}`, error));
  // Someone without the list (an editor who can't create) goes home.
  redirect(can(access, "reminders.create") || can(access, "reminders.view_all") ? `/reminders?notice=${encodeURIComponent("Reminder deleted.")}` : "/");
}

export async function decideReminderAction(fd: FormData) {
  const { user, companyId, access } = await requireMember();
  if (!can(access, "reminders.approve")) notFound();
  const id = str(fd, "id");
  if (!isUuid(id)) notFound();
  const approve = fd.get("decision") === "approve";
  const error = await decideReminder({ id: user.id, access }, companyId, id, approve, str(fd, "reason"));
  redirect(error ? errorUrl(`/reminders/${id}`, error) : `/reminders/${id}`);
}

const SERIES = { pause: pauseReminder, resume: resumeReminder, skip: skipNextOccurrence } as const;

// Pause / resume / skip next, chosen by the button's name="op".
export async function seriesAction(fd: FormData) {
  const { user, companyId, access } = await requireMember();
  const id = str(fd, "id");
  if (!isUuid(id)) notFound();
  const op = SERIES[str(fd, "op") as keyof typeof SERIES];
  if (!op) notFound();
  const error = await op({ id: user.id, access }, companyId, id);
  redirect(error ? errorUrl(`/reminders/${id}`, error) : `/reminders/${id}`);
}

// An assignee marks their own task done / not done (setDone checks ownership).
export async function markTaskAction(fd: FormData) {
  const { user, companyId } = await requireMember();
  const [id, assignmentId] = [str(fd, "id"), str(fd, "assignmentId")];
  if (!isUuid(id) || !isUuid(assignmentId)) notFound();
  const error = await setDone(user.id, companyId, assignmentId, fd.get("done") === "true");
  // From the My tasks page, go back there.
  const back = fd.get("next") ? safeNext(fd.get("next")) : `/reminders/${id}`;
  redirect(error ? errorUrl(back, error) : back);
}

// The shared "done" / "mark complete" of the latest occurrence (setOccurrenceDone checks who).
export async function markOccurrenceAction(fd: FormData) {
  const { user, companyId, access } = await requireMember();
  const [id, occurrenceId] = [str(fd, "id"), str(fd, "occurrenceId")];
  if (!isUuid(id) || !isUuid(occurrenceId)) notFound();
  const error = await setOccurrenceDone({ id: user.id, access }, companyId, occurrenceId, fd.get("done") === "true");
  redirect(error ? errorUrl(`/reminders/${id}`, error) : `/reminders/${id}`);
}

export async function sendNowAction(fd: FormData) {
  const { user, companyId, access } = await requireMember();
  const id = str(fd, "id");
  if (!isUuid(id)) notFound();
  const limited = await limits([[`send-now:user:${user.id}`, 10, 3600]]);
  if (limited) redirect(errorUrl(`/reminders/${id}`, limited));
  const r = await sendNow({ id: user.id, email: user.email, access }, companyId, id);
  if ("error" in r) redirect(errorUrl(`/reminders/${id}`, r.error!));
  const notice = r.mode === "extra" ? "Sent now. The next scheduled one is unchanged." : "Sending now.";
  redirect(`/reminders/${id}?notice=${encodeURIComponent(notice)}`);
}

export async function sendTestAction(fd: FormData) {
  const { user, companyId, access } = await requireMember();
  const id = str(fd, "id");
  if (!isUuid(id)) notFound();
  const limited = await limits([[`send-test:user:${user.id}`, 10, 3600]]);
  if (limited) redirect(errorUrl(`/reminders/${id}`, limited));
  const r = await sendTest({ id: user.id, email: user.email, access }, companyId, id);
  const via = (r.sent ?? []).map((c) => (c === "email" ? "email" : "Slack")).join(" and ");
  if ("error" in r && r.error) redirect(errorUrl(`/reminders/${id}`, via ? `Test sent by ${via}. ${r.error}` : r.error));
  redirect(`/reminders/${id}?notice=${encodeURIComponent(`Test sent to you by ${via}.`)}`);
}
