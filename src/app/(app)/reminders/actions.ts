"use server";

import { notFound, redirect } from "next/navigation";
import { errorUrl } from "@/components/form";
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
  if (!departmentIds.every(isUuid)) notFound();
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
      userIds: all(fd, "users"),
      emails: str(fd, "emails"),
      when: str(fd, "when"),
      sendAtLocal: str(fd, "sendAt"),
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
  );
  if (parsed.error !== undefined) redirect(errorUrl(back, parsed.error));

  const me = { id: user.id, access };
  if (id) {
    const error = await updateReminder(me, companyId, id, parsed.input);
    if (error) redirect(errorUrl(back, error));
    redirect(`/reminders/${id}`);
  }
  const created = await createReminder(me, companyId, parsed.input);
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
  const [id, deliveryId] = [str(fd, "id"), str(fd, "deliveryId")];
  if (!isUuid(id) || !isUuid(deliveryId)) notFound();
  const error = await setDone(user.id, companyId, deliveryId, fd.get("done") === "true");
  redirect(error ? errorUrl(`/reminders/${id}`, error) : `/reminders/${id}`);
}
