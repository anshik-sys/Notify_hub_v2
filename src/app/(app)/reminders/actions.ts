"use server";

import { notFound, redirect } from "next/navigation";
import { errorUrl, safeNext } from "@/components/form";
import { type CheckedFile, checkFile, MAX_FILES_PER_SAVE } from "@/lib/attachments";
import { can } from "@/lib/permissions";
import {
  cancelReminder,
  createReminder,
  decideReminder,
  pauseReminder,
  resumeReminder,
  skipNextOccurrence,
  updateReminder,
  validateInput,
} from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { limits } from "@/lib/rate-limit";
import { channelChoices } from "@/lib/slack-installations";
import { sendNow, sendTest } from "@/lib/send-now";
import { setDone } from "@/lib/tasks";
import { isUuid } from "@/lib/validate";

const all = (fd: FormData, name: string) => fd.getAll(name).map(String);
const str = (fd: FormData, name: string) => String(fd.get(name) ?? "");

// Creates when the form has no id, updates otherwise.
export async function saveReminder(fd: FormData) {
  const { user, companyId, company, access } = await requireMember();
  if (!can(access, "reminders.create")) notFound();
  const id = str(fd, "id");
  if (id && !isUuid(id)) notFound();
  const departmentIds = all(fd, "departments");
  const groupIds = all(fd, "groups");
  const [shareDepartmentIds, shareGroupIds] = [all(fd, "shareDepartments"), all(fd, "shareGroups")];
  if (![...departmentIds, ...groupIds, ...shareDepartmentIds, ...shareGroupIds].every(isUuid)) notFound();
  const back = id ? `/reminders/${id}/edit` : "/reminders/new";

  const parsed = validateInput(
    {
      title: str(fd, "title"),
      description: str(fd, "description"),
      senderName: str(fd, "senderName"),
      linkLabels: all(fd, "linkLabel"),
      linkUrls: all(fd, "linkUrl"),
      company: fd.get("company") === "on",
      departmentIds,
      groupIds,
      userIds: all(fd, "users"),
      emails: str(fd, "emails"),
      when: str(fd, "when"),
      sendAtLocal: str(fd, "sendAt"),
      channels: all(fd, "channels"),
      slackChannelIds: all(fd, "slackChannels"),
      tags: str(fd, "tags"),
      shareMine: fd.get("shareMine") === "on",
      shareDepartmentIds,
      shareGroupIds,
      shareCompany: fd.get("shareCompany") === "on",
      isTask: fd.get("isTask") === "on",
      dueLocal: str(fd, "due"),
      repeat: {
        repeat: str(fd, "repeat"),
        every: str(fd, "every"),
        unit: str(fd, "unit"),
        weekdays: all(fd, "weekdays"),
        monthlyBy: str(fd, "monthlyBy"),
        ends: str(fd, "ends"),
        until: str(fd, "until"),
        count: str(fd, "count"),
      },
    },
    company.timeZone,
    `Alerts | ${company.name}`,
    new Date(),
    // Only ask Slack for the channel list when the form uses Slack.
    all(fd, "channels").includes("slack") || all(fd, "slackChannels").length ? await channelChoices(companyId) : null,
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
  if (id) {
    const error = await updateReminder(me, companyId, id, parsed.input, files, removeAttachmentIds);
    if (error) redirect(errorUrl(back, error));
    redirect(`/reminders/${id}`);
  }
  const created = await createReminder(me, companyId, parsed.input, files);
  if ("error" in created) redirect(errorUrl(back, created.error));
  redirect(`/reminders/${created.id}`);
}

export async function cancelReminderAction(fd: FormData) {
  const { user, companyId, access } = await requireMember();
  const id = str(fd, "id");
  if (!isUuid(id)) notFound();
  const error = await cancelReminder({ id: user.id, access }, companyId, id);
  redirect(error ? errorUrl(`/reminders/${id}`, error) : `/reminders/${id}`);
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

export async function sendNowAction(fd: FormData) {
  const { user, companyId, access } = await requireMember();
  const id = str(fd, "id");
  if (!isUuid(id)) notFound();
  const r = await sendNow({ id: user.id, email: user.email, access }, companyId, id);
  if ("error" in r) redirect(errorUrl(`/reminders/${id}`, r.error!));
  const notice = r.mode === "extra" ? "Sent now. The next scheduled one is unchanged." : "Sending now.";
  redirect(`/reminders/${id}?notice=${encodeURIComponent(notice)}`);
}

export async function sendTestAction(fd: FormData) {
  const { user, companyId, access } = await requireMember();
  const id = str(fd, "id");
  if (!isUuid(id)) notFound();
  const r = await sendTest({ id: user.id, email: user.email, access }, companyId, id);
  const via = (r.sent ?? []).map((c) => (c === "email" ? "email" : "Slack")).join(" and ");
  if ("error" in r && r.error) redirect(errorUrl(`/reminders/${id}`, via ? `Test sent by ${via}. ${r.error}` : r.error));
  redirect(`/reminders/${id}?notice=${encodeURIComponent(`Test sent to you by ${via}.`)}`);
}
