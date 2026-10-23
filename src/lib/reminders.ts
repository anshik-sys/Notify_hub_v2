import { randomBytes } from "node:crypto";
import { aliasedTable, and, desc, eq, gte, inArray, isNull, notInArray, or, type SQL, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { attachments, companies, companyApprovers, deliveries, departmentMembers, emailSuppressions, departments, groupMembers, groups, notifications, reminderOccurrences, reminderShares, reminders, reminderTargets, roles, reminderColors, taskAssignments, user, userRoles, CALENDAR_COLORS, type CalendarColor, type ReminderStatus } from "@/db/schema";
import { type CheckedFile, MAX_FILES_PER_REMINDER } from "./attachments";
import { sendMail } from "./mail";
import { addNotifications, mutedFor, planTell, sendTell } from "./notifications";
import { dmLink } from "./slack-installations";
import { checkImage } from "./company";
import { copyCover, deleteCover, getBlob, getCover, putBlob, putCover } from "./storage";
import { resolveRecipients, type Target, type Tx } from "./recipients";
import { type Access, can, COMPANY_ADMIN_ROLE_ID, loadAccess } from "./permissions";
import { firstAtOrAfter, nextAfter, type RepeatFields, type Rule, ruleFromForm, shiftSeries, splitRule } from "./recurrence";
import { isWaiting, startAfter, syncParent, taskDone, WAITING_AT } from "./tasks";
import { toLocalInput, zonedToUtc } from "./time";

export type { Target };
export type ReminderInput = {
  title: string;
  description: string;
  links: { label: string; url: string }[];
  senderName: string;
  // First occurrence; for a series, the anchor's first match (see recurrence.ts).
  sendAt: Date;
  recurrence: Rule | null;
  anchorLocal: string;
  timeZone: string;
  isTask: boolean;
  dueAfterMinutes: number | null;
  channels: ("email" | "slack")[];
  tags: string[];
  targets: Target[];
  // PRD 5.4: who else may see it. "mine" = the creator's departments, expanded at save.
  shares: Share[];
  // PRD 14.3 events (left out = not an event; on an update, unchanged).
  isEvent?: boolean;
  durationMinutes?: number | null;
  allDay?: boolean;
  location?: string | null;
  meetingUrl?: string | null;
  notifyBefore?: number[];
  // PRD 14.5 sub-tasks of a one-time task. Left out = unchanged on an update;
  // [] removes them.
  subTasks?: SubTask[];
  // PRD 14.5 chain: starts when this task is done (sendAt is WAITING_AT till then).
  afterId?: string | null;
};
// userIds empty = the task's own recipients. row = its row in the form (covers
// are matched by it); cover as in saveCover.
export type SubTask = { id: string | null; row: number; title: string; dueAfterMinutes: number; userIds: string[]; cover?: CheckedFile | null };
export type Share = { kind: "mine" | "department" | "group" | "company"; ref: string | null };
type Actor = { id: string; access: Access };

class Refused extends Error {}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EDITABLE: ReminderStatus[] = ["pending_approval", "rejected", "scheduled", "paused"];

// --- Input -----------------------------------------------------------------

export type RawReminder = {
  title: string;
  description: string;
  senderName: string;
  linkLabels: string[];
  linkUrls: string[];
  company: boolean;
  departmentIds: string[];
  groupIds: string[];
  userIds: string[];
  emails: string;
  when: string; // "now" | "later" | "after" (when a task is done, PRD 14.5)
  afterId?: string;
  dueIn?: string; // a chained task: due this long after it starts
  dueUnit?: string; // "hours" | "days"
  sendAtLocal: string;
  repeat: RepeatFields;
  isTask: boolean;
  dueLocal: string;
  channels: string[]; // "email" | "slack"
  slackChannelIds: string[];
  tags: string; // comma separated
  shareMine: boolean;
  shareDepartmentIds: string[];
  shareGroupIds: string[];
  shareCompany: boolean;
  // PRD 14.3 (missing = not an event).
  isEvent?: boolean;
  endLocal?: string; // datetime-local, company zone
  allDay?: boolean;
  endDate?: string; // YYYY-MM-DD, all-day: the last day
  location?: string;
  meetingUrl?: string;
  notifyBefore?: string[]; // minutes, from NOTIFY_BEFORE
  // PRD 14.5 tasks: minutes before due, from REMIND_BEFORE, plus one custom time.
  remindBefore?: string[];
  remindCustom?: string;
  remindUnit?: string; // "minutes" | "hours" | "days"
  // PRD 14.5: one per filled-in row of the form (SUB_TASK_ROWS).
  subTasks?: { id: string; title: string; dueLocal: string; userIds: string[] }[];
};

export const SUB_TASK_ROWS = 10;

// The New/Edit form's post (reminder-form.tsx) -> RawReminder. The field names
// here must match the form's; reminder-form.test.ts checks that they do.
// Unticked checkboxes aren't sent at all, hence `=== "on"`.
export function formToRaw(fd: FormData): RawReminder {
  const str = (k: string) => String(fd.get(k) ?? "");
  const all = (k: string) => fd.getAll(k).map(String);
  return {
    title: str("title"),
    description: str("description"),
    senderName: str("senderName"),
    linkLabels: all("linkLabel"),
    linkUrls: all("linkUrl"),
    company: fd.get("company") === "on",
    departmentIds: all("departments"),
    groupIds: all("groups"),
    userIds: all("users"),
    emails: str("emails"),
    when: str("when"),
    sendAtLocal: str("sendAt"),
    afterId: str("after"),
    dueIn: str("dueIn"),
    dueUnit: str("dueUnit"),
    channels: all("channels"),
    slackChannelIds: all("slackChannels"),
    tags: str("tags"),
    shareMine: fd.get("shareMine") === "on",
    shareDepartmentIds: all("shareDepartments"),
    shareGroupIds: all("shareGroups"),
    shareCompany: fd.get("shareCompany") === "on",
    // Reminder / Task / Event: one choice (spec EV9).
    isTask: str("kind") === "task",
    isEvent: str("kind") === "event",
    endLocal: str("endsAt"),
    allDay: fd.get("allDay") === "on",
    endDate: str("endDate"),
    location: str("location"),
    meetingUrl: str("meetingUrl"),
    notifyBefore: all("notifyBefore"),
    remindBefore: all("remindBefore"),
    remindCustom: str("remindCustom"),
    remindUnit: str("remindUnit"),
    dueLocal: str("due"),
    subTasks: Array.from({ length: SUB_TASK_ROWS }, (_, i) => ({
      id: str(`sub.${i}.id`),
      title: str(`sub.${i}.title`),
      dueLocal: str(`sub.${i}.due`),
      userIds: all(`sub.${i}.users`),
    })),
    repeat: {
      repeat: str("repeat"),
      every: str("every"),
      unit: str("unit"),
      weekdays: all("weekdays"),
      monthlyBy: str("monthlyBy"),
      ends: str("ends"),
      until: str("until"),
      count: str("count"),
    },
  };
}

// slack: the company's public channels when Slack is connected, else null.
export function validateInput(
  raw: RawReminder,
  timeZone: string,
  defaultSender: string,
  now = new Date(),
  slack: { id: string; name: string }[] | null = null,
) {
  const title = raw.title.trim();
  if (!title || title.length > 200) return { error: "Title must be 1–200 characters." };
  const description = raw.description.trim();
  if (description.length > 5000) return { error: "Description must be at most 5000 characters." };
  const senderName = raw.senderName.trim() || defaultSender;
  if (senderName.length > 100) return { error: "Sender name must be at most 100 characters." };

  const links: ReminderInput["links"] = [];
  for (let i = 0; i < raw.linkUrls.length; i++) {
    const rawUrl = raw.linkUrls[i]?.trim();
    if (!rawUrl) continue;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { error: `"${rawUrl}" isn't a valid link.` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "Links must start with http:// or https://." };
    links.push({ label: raw.linkLabels[i]?.trim().slice(0, 100) || url.hostname, url: url.href });
  }
  if (links.length > 10) return { error: "At most 10 links." };

  const emails = [...new Set(raw.emails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const badEmail = emails.find((e) => !EMAIL.test(e));
  if (badEmail) return { error: `"${badEmail}" isn't a valid email.` };

  const targets: Target[] = raw.company
    ? [{ kind: "company", ref: null }]
    : [
        ...[...new Set(raw.departmentIds)].map((ref) => ({ kind: "department" as const, ref })),
        ...[...new Set(raw.groupIds)].map((ref) => ({ kind: "group" as const, ref })),
        ...[...new Set(raw.userIds)].map((ref) => ({ kind: "user" as const, ref })),
      ];
  targets.push(...emails.map((ref) => ({ kind: "email" as const, ref })));

  // Channels (PRD 5.3).
  const channels = [...new Set(raw.channels)].filter((c): c is "email" | "slack" => c === "email" || c === "slack");
  if (channels.length === 0) return { error: "Choose at least one channel: email or Slack." };
  // Channel picks only count with Slack ticked: the form hides them otherwise,
  // so leftovers from unticking Slack are dropped rather than refused.
  const slackChannels = channels.includes("slack") ? [...new Set(raw.slackChannelIds)].map((id) => slack?.find((c) => c.id === id)) : [];
  if (channels.includes("slack")) {
    if (!slack) return { error: "Slack isn't connected. An admin can connect it under Integrations." };
    if (slackChannels.some((c) => !c)) return { error: "One of the Slack channels no longer exists." };
    const people = targets.some((t) => t.kind === "user" || t.kind === "department" || t.kind === "group");
    if (raw.company && !slackChannels.length)
      return { error: "To send to the whole company on Slack, pick a Slack channel. Everyone isn't messaged one by one." };
    if (!people && !raw.company && !slackChannels.length)
      return { error: "Slack needs a channel, people, a department or a group." };
  }
  if (channels.includes("email") && !targets.length)
    return { error: "Email needs people, a department, a group, the whole company or email addresses." };
  targets.push(...slackChannels.map((c) => ({ kind: "slack_channel" as const, ref: c!.id, label: c!.name })));
  if (targets.length === 0) return { error: "Choose at least one recipient." };

  let sendAt = now;
  // CH1: waits for a task instead of a send time.
  const after = raw.when === "after";
  if (after) {
    if (!raw.afterId) return { error: "Pick the task it waits for." };
    if (raw.repeat.repeat !== "none") return { error: "Something that waits for a task can’t repeat." };
    sendAt = WAITING_AT;
  }
  if (raw.when === "later") {
    const at = zonedToUtc(raw.sendAtLocal, timeZone);
    if (!at) return { error: "Pick a date and time to send." };
    if (at.getTime() < now.getTime() - 60_000) return { error: "Pick a time in the future." };
    sendAt = at;
  }
  // The start, as wall clock in the company zone ("now" is truncated to the minute).
  const anchorLocal = raw.when === "later" ? raw.sendAtLocal : toLocalInput(now, timeZone);
  const parsed = ruleFromForm(raw.repeat, anchorLocal);
  if ("error" in parsed) return { error: parsed.error };
  const recurrence = parsed.rule;
  if (recurrence) {
    // First match at or after the start: the start itself, unless e.g. "every
    // Monday" was picked with a Wednesday start.
    const first = firstAtOrAfter(recurrence, anchorLocal, timeZone, zonedToUtc(anchorLocal, timeZone)!);
    if (!first) return { error: "That repeat never happens. Check the end date." };
    sendAt = first;
  }
  // Events (PRD 14.3): members only as guests, a start and an end (or whole
  // days), where, a meeting link, and when to say "starts soon".
  let event: Pick<ReminderInput, "isEvent" | "durationMinutes" | "allDay" | "location" | "meetingUrl" | "notifyBefore"> = {};
  if (raw.isEvent) {
    if (raw.isTask) return { error: "Pick one: reminder, task or event." };
    if (targets.some((t) => t.kind === "email") || slackChannels.length)
      return { error: "An event's guests must be people in the company: no outside emails or Slack channels." };
    if (raw.when !== "later") return { error: "An event needs a start date and time." };
    let durationMinutes: number;
    if (raw.allDay) {
      const first = raw.sendAtLocal.slice(0, 10);
      const last = raw.endDate || first;
      const days = Math.round((Date.parse(`${last}T00:00Z`) - Date.parse(`${first}T00:00Z`)) / 86_400_000) + 1;
      if (!(days >= 1)) return { error: "The last day must be on or after the first." };
      if (days > 31) return { error: "An event can last at most 31 days." };
      durationMinutes = days * 1440;
      // All-day: from midnight on the first day.
      const midnight = zonedToUtc(`${first}T00:00`, timeZone);
      if (!midnight) return { error: "Pick a start date." };
      sendAt = recurrence ? firstAtOrAfter(recurrence, `${first}T00:00`, timeZone, midnight)! : midnight;
    } else if (!raw.endLocal) {
      durationMinutes = 60; // no end picked: an hour, as in Google Calendar
    } else {
      const end = zonedToUtc(raw.endLocal, timeZone);
      if (!end) return { error: "Pick when the event ends." };
      durationMinutes = Math.round((end.getTime() - zonedToUtc(anchorLocal, timeZone)!.getTime()) / 60_000);
      if (durationMinutes < 1) return { error: "The event must end after it starts." };
      if (durationMinutes > 14 * 1440) return { error: "An event can last at most 14 days; use all day for longer." };
    }
    const location = raw.location?.trim() || null;
    if (location && location.length > 200) return { error: "Location must be at most 200 characters." };
    let meetingUrl: string | null = null;
    if (raw.meetingUrl?.trim()) {
      let u: URL;
      try {
        u = new URL(raw.meetingUrl.trim());
      } catch {
        return { error: "The meeting link isn't a valid link." };
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "The meeting link must start with http:// or https://." };
      meetingUrl = u.href.slice(0, 2000);
    }
    const before = [...new Set((raw.notifyBefore ?? []).filter(Boolean).map(Number))];
    if (before.some((m) => !NOTIFY_BEFORE.includes(m))) return { error: "Pick when to be told from the list." };
    event = { isEvent: true, durationMinutes, allDay: Boolean(raw.allDay), location, meetingUrl, notifyBefore: before.sort((a, b) => b - a) };
  }
  // Tasks: due is a wall-clock time after the first send, stored as an offset
  // so each occurrence of a repeating task is due the same time after it's sent.
  let dueAfterMinutes: number | null = null;
  let remind: Pick<ReminderInput, "notifyBefore"> = {};
  if (raw.isTask && !raw.isEvent) {
    if (after) {
      // CH2: due a while after it starts, as that time isn't known yet.
      const n = Number(raw.dueIn);
      const unit = UNIT_MINUTES[raw.dueUnit ?? ""];
      if (!Number.isInteger(n) || n < 1 || !unit) return { error: "Say how long after it starts the task is due." };
      dueAfterMinutes = n * unit;
    } else {
      const due = zonedToUtc(raw.dueLocal, timeZone);
      if (!due) return { error: "A task needs a due date and time." };
      dueAfterMinutes = Math.round((due.getTime() - sendAt.getTime()) / 60_000);
    }
    if (dueAfterMinutes < 1) return { error: "The due time must be after it's sent." };
    if (dueAfterMinutes > 365 * 24 * 60) return { error: "The due time must be within a year of sending." };
    const before = remindBefore(raw, dueAfterMinutes);
    if ("error" in before) return before;
    remind = { notifyBefore: before.minutes };
  }
  // PRD 14.5 sub-tasks (ST1, ST3, ST10). Anything but a task drops them, like the cover.
  const subTasks: SubTask[] = [];
  for (const [row, s] of (raw.subTasks ?? []).entries()) {
    // A row without a title isn't one (clearing it removes the sub-task).
    const subTitle = s.title.trim();
    if (!raw.isTask || raw.isEvent || !subTitle) continue;
    if (subTitle.length > 200) return { error: "A sub-task’s title must be at most 200 characters." };
    if (recurrence) return { error: "A repeating task can’t have sub-tasks." };
    if (after) return { error: "A task that waits for another can’t have sub-tasks." };
    const due = zonedToUtc(s.dueLocal, timeZone);
    if (!due) return { error: `Sub-task “${subTitle}” needs a due date and time.` };
    const minutes = Math.round((due.getTime() - sendAt.getTime()) / 60_000);
    if (minutes < 1 || minutes > dueAfterMinutes!)
      return { error: `Sub-task “${subTitle}” must be due after the task is sent and no later than the task.` };
    subTasks.push({ id: s.id || null, row, title: subTitle, dueAfterMinutes: minutes, userIds: [...new Set(s.userIds)] });
  }
  const tags = parseTags(raw.tags);
  if ("error" in tags) return tags;
  // The whole company covers every narrower share.
  const shares: Share[] = raw.shareCompany
    ? [{ kind: "company", ref: null }]
    : [
        ...(raw.shareMine ? [{ kind: "mine" as const, ref: null }] : []),
        ...[...new Set(raw.shareDepartmentIds)].map((ref) => ({ kind: "department" as const, ref })),
        ...[...new Set(raw.shareGroupIds)].map((ref) => ({ kind: "group" as const, ref })),
      ];
  return {
    input: {
      shares,
      tags: tags.tags,
      title,
      description,
      links,
      senderName,
      sendAt,
      recurrence,
      anchorLocal,
      timeZone,
      isTask: raw.isTask,
      dueAfterMinutes,
      channels,
      targets,
      ...event,
      ...remind,
      subTasks,
      afterId: after ? raw.afterId! : null,
      // An all-day event is anchored at midnight on its first day.
      ...(event.allDay ? { anchorLocal: `${raw.sendAtLocal.slice(0, 10)}T00:00` } : {}),
    } satisfies ReminderInput,
  };
}

// PRD 14.3 "starts soon": the times offered, in minutes before the start.
export const NOTIFY_BEFORE = [10, 30, 60, 1440];

// PRD 14.5 "remind before due" (RB1): 1 hour, 1 day, 2 days, 1 week, and one
// custom time. Each must fall after the task is sent (RB5). The form ticks
// 1 day for a new task; when that alone doesn't fit (due within a day of
// sending) it's dropped rather than refused, so the default never blocks a save.
export const REMIND_BEFORE = [60, 1440, 2880, 10080];

const UNIT_MINUTES: Record<string, number> = { minutes: 1, hours: 60, days: 1440 };
const MAX_REMIND_BEFORE = 5;
export function remindBefore(raw: Pick<RawReminder, "remindBefore" | "remindCustom" | "remindUnit">, dueAfterMinutes: number): { minutes: number[] } | { error: string } {
  const picked = (raw.remindBefore ?? []).filter(Boolean).map(Number);
  if (picked.some((m) => !REMIND_BEFORE.includes(m))) return { error: "Pick when to remind from the list." };
  const custom = raw.remindCustom?.trim() ?? "";
  if (custom) {
    const n = Number(custom);
    const unit = UNIT_MINUTES[raw.remindUnit ?? ""];
    if (!Number.isInteger(n) || n < 1 || !unit) return { error: "The custom reminder must be a whole number of minutes, hours or days." };
    picked.push(n * unit);
  }
  const minutes = [...new Set(picked)].sort((a, b) => b - a);
  if (minutes.length > MAX_REMIND_BEFORE) return { error: `At most ${MAX_REMIND_BEFORE} reminders before due.` };
  if (!custom && minutes.length === 1 && minutes[0] === 1440 && dueAfterMinutes <= 1440) return { minutes: [] };
  if (minutes.some((m) => m >= dueAfterMinutes))
    return { error: "Remind before due must be less than the time between sending and due." };
  return { minutes };
}

// "" = the type's default (null); a palette name; anything else = undefined (refused).
const colorFrom = (raw: string): CalendarColor | null | undefined =>
  raw === "" ? null : CALENDAR_COLORS.includes(raw as CalendarColor) ? (raw as CalendarColor) : undefined;

const TAG = /^[a-z0-9][a-z0-9 _-]{0,29}$/;

// Lowercased and de-duplicated; at most 10 of 1–30 characters.
export function parseTags(raw: string): { tags: string[] } | { error: string } {
  const tags = [...new Set(raw.split(",").map((t) => t.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean))];
  const bad = tags.find((t) => !TAG.test(t));
  if (bad) return { error: `"${bad}" isn't a valid tag: use letters, numbers, spaces, - or _, up to 30 characters.` };
  if (tags.length > 10) return { error: "At most 10 tags." };
  return { tags };
}

// --- Recipients and scope ---------------------------------------------------

type Resolved = Awaited<ReturnType<typeof resolveRecipients>>;

// PRD 5.2. Returns what's out of scope (empty = no approval needed).
// Scope: members of every department the sender is in, including its managers.
export async function outOfScope(tx: Tx, companyId: string, actor: Actor, targets: Target[], resolved: Resolved) {
  if (can(actor.access, "reminders.approve")) return [];
  const mine = await tx
    .select({ id: departmentMembers.departmentId })
    .from(departmentMembers)
    .where(and(eq(departmentMembers.companyId, companyId), eq(departmentMembers.userId, actor.id)));
  const myDepts = mine.map((d) => d.id);
  const inScope = new Set([actor.id]);
  if (myDepts.length) {
    const colleagues = await tx
      .select({ id: departmentMembers.userId })
      .from(departmentMembers)
      .where(and(eq(departmentMembers.companyId, companyId), inArray(departmentMembers.departmentId, myDepts)));
    colleagues.forEach((c) => inScope.add(c.id));
  }

  const reasons: string[] = [];
  if (targets.some((t) => t.kind === "company")) reasons.push("the whole company");
  const otherDepts = targets.filter((t) => t.kind === "department" && !myDepts.includes(t.ref!)).map((t) => t.ref!);
  if (otherDepts.length) {
    const names = await tx.select({ name: departments.name }).from(departments).where(inArray(departments.id, otherDepts));
    reasons.push(...names.map((n) => `the ${n.name} department`));
  }
  // A group with anyone outside the sender's scope needs approval (PRD 4); its
  // outsiders are also listed by email below.
  const groupIds = targets.filter((t) => t.kind === "group").map((t) => t.ref!);
  if (groupIds.length) {
    const members = await tx
      .select({ name: groups.name, userId: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .innerJoin(user, eq(user.id, groupMembers.userId))
      .where(and(eq(groupMembers.companyId, companyId), inArray(groupMembers.groupId, groupIds), isNull(user.deactivatedAt)));
    const wide = new Set(members.filter((m) => !inScope.has(m.userId)).map((m) => m.name));
    reasons.push(...[...wide].map((n) => `the ${n} group (has people outside your departments)`));
  }
  reasons.push(...resolved.users.filter((u) => !inScope.has(u.id)).map((u) => u.email));
  reasons.push(...resolved.external.map((e) => `${e} (outside the company)`));
  // ponytail: a channel's audience isn't known up front, so any channel counts
  // as out of scope; upgrade: map conversations.members to users by email.
  reasons.push(...targets.filter((t) => t.kind === "slack_channel").map((t) => `the #${t.label ?? t.ref} Slack channel`));
  return [...new Set(reasons)];
}

// --- Lifecycle ---------------------------------------------------------------

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
const shortId = () => `R-${[...randomBytes(6)].map((b) => ALPHABET[b % 32]).join("")}`;

// Who decides out-of-scope sends (PRD 9.1): everyone active with
// reminders.approve, or in 'named' mode only the named ones among them.
// Named approvers who lost the permission or left don't count; if that
// leaves nobody, it falls back to everyone, so approvals never get stuck.
async function approverIds(tx: Tx, companyId: string) {
  const all = await tx
    .selectDistinct({ id: user.id, email: user.email })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(user, eq(user.id, userRoles.userId))
    .where(
      and(
        isNull(user.deactivatedAt),
        or(eq(roles.id, COMPANY_ADMIN_ROLE_ID), sql`'reminders.approve' = any(${roles.permissions})`),
      ),
    );
  const [c] = await tx.select({ mode: companies.approvalMode }).from(companies).where(eq(companies.id, companyId));
  if (c?.mode !== "named") return all;
  const named = new Set((await tx.select({ id: companyApprovers.userId }).from(companyApprovers)).map((n) => n.id));
  const picked = all.filter((a) => named.has(a.id));
  return picked.length ? picked : all;
}

// May this person approve or reject right now?
export async function mayDecide(companyId: string, actor: Actor) {
  if (!can(actor.access, "reminders.approve")) return false;
  return withTenant(companyId, async (tx) => (await approverIds(tx, companyId)).some((a) => a.id === actor.id));
}

// Every approver gets it in the notification centre; returns who to tell by
// email and by Slack, leaving out what each one muted.
async function approversToTell(tx: Tx, companyId: string, reminderId: string) {
  const rows = await approverIds(tx, companyId);
  await addNotifications(
    tx,
    rows.map((r) => ({ companyId, userId: r.id, kind: "approval", reminderId, text: "Needs your approval" })),
  );
  const muted = await mutedFor(
    tx,
    rows.map((r) => r.id),
    "approval",
  );
  return rows.map((r) => ({ email: r.email, mail: !muted.has(`${r.id}:email`), slack: !muted.has(`${r.id}:slack`) }));
}

type Approver = Awaited<ReturnType<typeof approversToTell>>[number];

async function notifyApprovers(companyId: string, approvers: Approver[], title: string, id: string) {
  const url = `${process.env.BETTER_AUTH_URL}/reminders/${id}`;
  const text = `A reminder needs your approval before it can be sent: "${title}".`;
  for (const a of approvers) {
    if (a.mail)
      await sendMail({ to: a.email, subject: `Approval needed: ${title}`, text, links: [{ label: "Review it", url }] }).catch((e) =>
        console.error("approval email failed", e),
      );
    if (a.slack) await dmLink(companyId, a.email, text, { label: "Review it", url }).catch((e) => console.error("approval Slack DM failed", e));
  }
}

// Replaces the reminder's shares. "mine" becomes the creator's current
// departments, so the saved list is explicit; unknown ids are dropped.
async function saveShares(tx: Tx, companyId: string, reminderId: string, creator: string, shares: Share[]) {
  await tx.delete(reminderShares).where(eq(reminderShares.reminderId, reminderId));
  const rows: { kind: "department" | "group" | "company"; ref: string | null }[] = [];
  if (shares.some((x) => x.kind === "company")) rows.push({ kind: "company", ref: null });
  else {
    const wanted = new Set(shares.filter((x) => x.kind === "department").map((x) => x.ref!));
    if (shares.some((x) => x.kind === "mine")) {
      const mine = await tx.select({ id: departmentMembers.departmentId }).from(departmentMembers).where(eq(departmentMembers.userId, creator));
      mine.forEach((d) => wanted.add(d.id));
    }
    const isId = (x: string) => /^[0-9a-f-]{36}$/i.test(x);
    const depts = [...wanted].filter(isId);
    const grps = shares.filter((x) => x.kind === "group").map((x) => x.ref!).filter(isId);
    if (depts.length) rows.push(...(await tx.select({ id: departments.id }).from(departments).where(inArray(departments.id, depts))).map((d) => ({ kind: "department" as const, ref: d.id })));
    if (grps.length) rows.push(...(await tx.select({ id: groups.id }).from(groups).where(inArray(groups.id, grps))).map((g) => ({ kind: "group" as const, ref: g.id })));
  }
  if (rows.length) await tx.insert(reminderShares).values(rows.map((r) => ({ ...r, reminderId, companyId })));
}

async function checked(tx: Tx, companyId: string, actor: Actor, input: ReminderInput) {
  const resolved = await resolveRecipients(tx, companyId, input.targets);
  if (resolved.users.length + resolved.external.length === 0)
    throw new Refused("Nobody would receive this: the chosen departments have no active members.");
  return outOfScope(tx, companyId, actor, input.targets, resolved);
}

// A sub-task as a reminder of its own: the task's content, channels, sharing
// and send time; its own title ("Laptop (Onboarding)", ST2), people (or the
// task's recipients), due time and the remind-before times that fit (ST6).
const subTaskInput = (task: ReminderInput, s: SubTask): ReminderInput => ({
  ...task,
  title: `${s.title} (${task.title})`,
  targets: s.userIds.length ? s.userIds.map((ref) => ({ kind: "user" as const, ref })) : task.targets,
  dueAfterMinutes: s.dueAfterMinutes,
  notifyBefore: (task.notifyBefore ?? []).filter((m) => m < s.dueAfterMinutes),
  subTasks: undefined,
});
const withSubTasks = (input: ReminderInput) => [input, ...(input.subTasks ?? []).map((s) => subTaskInput(input, s))];

// ST8: the task and its sub-tasks are approved together, so any of them out
// of scope means the whole task waits.
async function checkedAll(tx: Tx, companyId: string, actor: Actor, input: ReminderInput) {
  const out: string[] = [];
  for (const one of withSubTasks(input)) out.push(...(await checked(tx, companyId, actor, one)));
  return [...new Set(out)];
}

// The reminders row's own columns, and what's saved in other tables.
const split = <T extends ReminderInput>({ targets, shares, subTasks, ...fields }: T) => ({ targets, shares, subTasks, fields });

// CH7: what a reminder can wait for: a one-time task the actor can open, not
// done, cancelled or deleted; never itself or something waiting for it.
async function checkAfter(tx: Tx, companyId: string, actor: Actor, afterId: string, selfId?: string) {
  const [a] = await tx
    .select({ id: reminders.id, createdBy: reminders.createdBy, isTask: reminders.isTask, recurrence: reminders.recurrence, status: reminders.status, done: taskDone })
    .from(reminders)
    .where(and(eq(reminders.id, afterId), isNull(reminders.deletedAt)));
  const [me] = await tx.select({ email: user.email }).from(user).where(eq(user.id, actor.id));
  if (!a || !me || !(await reminderAccess(companyId, { ...actor, email: me.email }, a))) throw new Refused("The task it waits for wasn’t found.");
  if (!a.isTask || a.recurrence) throw new Refused("It can only wait for a task that doesn’t repeat.");
  if (a.status === "cancelled" || a.status === "rejected") throw new Refused("The task it waits for was cancelled or not approved.");
  if (a.done) throw new Refused("The task it waits for is already done.");
  for (let at: string | null = afterId, steps = 0; at && steps < 100; steps++) {
    if (at === selfId) throw new Refused("That would make it wait for itself.");
    [{ at }] = await tx.select({ at: reminders.afterId }).from(reminders).where(eq(reminders.id, at));
  }
}

// CH8: what waits for a cancelled or deleted task (or one of its sub-tasks)
// is cancelled too, and so is whatever waits for that; their creators are
// told in the app.
async function cancelWaiting(tx: Tx, companyId: string, taskId: string) {
  const gone: { rows: { id: string; created_by: string }[] } = await tx.execute(sql`
    with recursive w(id) as (
      select id from reminders where (after_id = ${taskId} or after_id in (select id from reminders where parent_id = ${taskId}))
        and send_at = ${WAITING_AT} and deleted_at is null and status <> 'cancelled'
      union
      select r.id from reminders r join w on r.after_id = w.id where r.send_at = ${WAITING_AT} and r.deleted_at is null and r.status <> 'cancelled')
    update reminders r set status = 'cancelled' from w where r.id = w.id returning r.id, r.created_by`);
  await addNotifications(
    tx,
    gone.rows.map((b) => ({ companyId, userId: b.created_by, kind: "chain", reminderId: b.id, text: "Cancelled: the task it waited for was cancelled or deleted" })),
  );
}

// Sub-tasks change only through their task's form (ST1).
function notSubTask(r: { parentId: string | null }) {
  if (r.parentId) throw new Refused("This is a sub-task: change it from its task.");
}

// What happens to a task happens to its sub-tasks (ST8, ST11): approval,
// cancelling, deleting, a new send time.
const toSubTasks = (tx: Tx, parentId: string, set: Partial<typeof reminders.$inferInsert>) =>
  tx.update(reminders).set(set).where(and(eq(reminders.parentId, parentId), isNull(reminders.deletedAt)));

// ST1: saved with the task, as one-time tasks of their own. Only an unsent
// task can be edited, so a sub-task removed here never went out.
async function saveSubTasks(
  tx: Tx,
  companyId: string,
  actorId: string,
  parentId: string,
  input: ReminderInput,
  set: Pick<typeof reminders.$inferInsert, "createdBy" | "status" | "decidedBy" | "decidedAt">,
) {
  if (!input.subTasks) return;
  const kept = input.subTasks.flatMap((x) => (x.id ? [x.id] : []));
  await tx.delete(reminders).where(and(eq(reminders.parentId, parentId), kept.length ? notInArray(reminders.id, kept) : undefined));
  for (const x of input.subTasks) {
    const child = { ...subTaskInput(input, x), ...set, parentId };
    if (!x.id) {
      // Listed in form order (createdAt), new ones after those already saved.
      await insertReminder(tx, companyId, actorId, { ...child, createdAt: new Date(Date.now() + x.row) }, [], x.cover);
      continue;
    }
    const { targets, shares, fields } = split(child);
    const [row] = await tx
      .update(reminders)
      .set({ ...fields, rejectionReason: null })
      .where(and(eq(reminders.id, x.id), eq(reminders.parentId, parentId)))
      .returning({ id: reminders.id });
    if (!row) throw new Refused("A sub-task changed meanwhile. Reload the page and try again.");
    await tx.delete(reminderTargets).where(eq(reminderTargets.reminderId, x.id));
    await tx.insert(reminderTargets).values(targets.map((t) => ({ ...t, reminderId: x.id!, companyId })));
    await saveShares(tx, companyId, x.id, actorId, shares);
    await saveCover(tx, companyId, x.id, true, x.cover);
  }
}

async function saveAttachments(tx: Tx, companyId: string, reminderId: string, by: string, files: CheckedFile[], remove: string[]) {
  if (remove.length)
    await tx.delete(attachments).where(and(eq(attachments.reminderId, reminderId), inArray(attachments.id, remove)));
  if (!files.length) return;
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(attachments)
    .where(eq(attachments.reminderId, reminderId));
  if (n + files.length > MAX_FILES_PER_REMINDER) throw new Refused(`A reminder can have at most ${MAX_FILES_PER_REMINDER} attachments.`);
  for (const f of files) {
    const [row] = await tx
      .insert(attachments)
      .values({
        companyId,
        reminderId,
        fileName: f.fileName,
        contentType: f.contentType,
        size: f.size,
        sha256: f.sha256,
        uploadedBy: by,
        // clock_timestamp, not now(): files saved together keep their upload
        // order (now() is the same for the whole transaction).
        createdAt: sql`clock_timestamp()`,
      })
      .returning({ id: attachments.id });
    await putBlob(tx, row.id, companyId, f.data);
  }
}

export function listAttachments(companyId: string, reminderId: string) {
  return withTenant(companyId, (tx) =>
    tx
      .select({ id: attachments.id, fileName: attachments.fileName, size: attachments.size, contentType: attachments.contentType })
      .from(attachments)
      .where(eq(attachments.reminderId, reminderId))
      .orderBy(attachments.createdAt),
  );
}

// PRD 14.5 cover image (CV1): one raster image per task, checked by its bytes.
export const COVER_MAX_BYTES = 5 * 1024 * 1024;
export const checkCover = (fileName: string, bytes: Uint8Array) => checkImage(fileName, bytes, COVER_MAX_BYTES, "cover image");

// cover: undefined keeps it, null removes it, a file replaces it (CV4). Only
// tasks have one (CV6): turning a task into a reminder or event drops it.
async function saveCover(tx: Tx, companyId: string, reminderId: string, isTask: boolean, cover: CheckedFile | null | undefined) {
  if (!isTask || cover === null) await deleteCover(tx, reminderId);
  else if (cover) await putCover(tx, companyId, reminderId, cover.contentType, cover.data);
}

// The task page's banner; ?v= changes with the image, so it can be cached.
export async function coverUrl(companyId: string, reminderId: string) {
  const c = await withTenant(companyId, (tx) => getCover(tx, reminderId));
  return c ? `/api/cover/${reminderId}?v=${c.updatedAt.getTime()}` : null;
}

// For /api/cover/<reminder id>; the route checks the viewer can open the task (CV3).
export const coverFile = (companyId: string, reminderId: string) => withTenant(companyId, (tx) => getCover(tx, reminderId));

// Wakes the worker (LISTEN reminders_due) so "now" means now. Postgres only
// delivers it if this transaction commits. The worker's minute tick catches
// anything a missed notification would have left behind. A scheduled event
// wakes it too: its invites go at once (PRD 14.3), not at the start.
async function notifyIfDue(tx: Tx, status: ReminderStatus, sendAt: Date, isEvent = false) {
  if (status === "scheduled" && (isEvent || sendAt.getTime() <= Date.now())) await tx.execute(sql`select pg_notify('reminders_due', '')`);
}

async function refusals<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Refused) return { error: e.message };
    throw e;
  }
}

// files: already checked (checkFile in src/lib/attachments.ts); stored in the
// same transaction as the reminder, so a reminder never exists half-saved.
export async function createReminder(actor: Actor, companyId: string, input: ReminderInput, files: CheckedFile[] = [], cover?: CheckedFile | null) {
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      if (input.afterId) await checkAfter(tx, companyId, actor, input.afterId);
      const out = await checkedAll(tx, companyId, actor, input);
      const status: ReminderStatus = out.length ? "pending_approval" : "scheduled";
      const id = await insertReminder(tx, companyId, actor.id, { ...input, createdBy: actor.id, status }, files, cover);
      await saveSubTasks(tx, companyId, actor.id, id, input, { createdBy: actor.id, status });
      return { id, approvers: status === "pending_approval" ? await approversToTell(tx, companyId, id) : [] };
    }),
  );
  if ("error" in result) return result;
  await notifyApprovers(companyId, result.approvers, input.title, result.id);
  return { id: result.id };
}

// A new reminder row with its targets, shares and files (actorId uploads them
// and expands "my departments").
async function insertReminder(
  tx: Tx,
  companyId: string,
  actorId: string,
  input: ReminderInput &
    Pick<typeof reminders.$inferInsert, "createdBy" | "status" | "decidedBy" | "decidedAt" | "replacesSeriesId" | "replacesOccursAt" | "parentId" | "createdAt">,
  files: CheckedFile[],
  cover?: CheckedFile | null,
) {
  const { targets, shares, fields } = split(input);
  let id = "";
  for (let attempt = 0; !id; attempt++) {
    const [row] = await tx
      .insert(reminders)
      .values({ ...fields, companyId, shortId: shortId() })
      .onConflictDoNothing({ target: reminders.shortId })
      .returning({ id: reminders.id });
    if (row) id = row.id;
    else if (attempt > 3) throw new Error("could not allocate a short id");
  }
  await tx.insert(reminderTargets).values(targets.map((t) => ({ ...t, reminderId: id, companyId })));
  await saveShares(tx, companyId, id, actorId, shares);
  await saveAttachments(tx, companyId, id, actorId, files, []);
  await saveCover(tx, companyId, id, input.isTask, cover);
  await notifyIfDue(tx, fields.status, input.sendAt, "isEvent" in input && input.isEvent);
  return id;
}

const targetKey = (t: Target) => `${t.kind}:${t.ref}`;

// Creator, or anyone with the permission (reminders.edit, or send_now for Send
// now) who can also see the reminder in full. Without that, the permission
// alone would open any reminder in the company by id. The edit and detail
// pages use this too, so the buttons match the rule.
export async function mayChange(
  companyId: string,
  actor: Actor,
  createdBy: string,
  permission: "reminders.edit" | "reminders.send_now" = "reminders.edit",
) {
  if (actor.id === createdBy) return true;
  return can(actor.access, permission) && canSeeReminder(companyId, actor, createdBy);
}

export async function updateReminder(
  actor: Actor,
  companyId: string,
  id: string,
  input: ReminderInput,
  files: CheckedFile[] = [],
  removeAttachmentIds: string[] = [],
  cover?: CheckedFile | null,
) {
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const [current] = await tx.select().from(reminders).where(eq(reminders.id, id)).for("update");
      if (!current || !(await mayChange(companyId, actor, current.createdBy))) throw new Refused("Reminder not found.");
      notSubTask(current);
      if (!EDITABLE.includes(current.status)) throw new Refused("This reminder can no longer be edited.");
      if (input.afterId) await checkAfter(tx, companyId, actor, input.afterId, id);

      // The scope check runs as the creator (it's their send) and, when someone
      // else edits, as the editor too: the stricter wins. Otherwise an editor
      // without approve could widen an approver's reminder unchecked.
      const creator = { id: current.createdBy, access: await loadAccess(companyId, current.createdBy) };
      const out = await checkedAll(tx, companyId, creator, input);
      if (actor.id !== creator.id) out.push(...(await checkedAll(tx, companyId, actor, input)));
      // The task's and its sub-tasks' (ST8).
      const oldTargets = await tx
        .select()
        .from(reminderTargets)
        .where(or(eq(reminderTargets.reminderId, id), sql`${reminderTargets.reminderId} in (select id from reminders where parent_id = ${id})`));
      // An approval covers the recipients it saw. Same or fewer targets keeps it;
      // anything new needs approving again (PRD 5.9).
      const approved = current.status === "scheduled" && current.decidedBy !== null;
      const oldKeys = new Set(oldTargets.map(targetKey));
      const narrowed = withSubTasks(input).every((one) => one.targets.every((t) => oldKeys.has(targetKey(t))));
      // A paused series stays paused through an edit (unless it now needs approval).
      const status: ReminderStatus =
        out.length && !(approved && narrowed) ? "pending_approval" : current.status === "paused" ? "paused" : "scheduled";
      // An approver editing a waiting reminder into shape approves it (PRD 5.9).
      const approvesIt =
        current.status === "pending_approval" && status === "scheduled" && actor.id !== creator.id && can(actor.access, "reminders.approve");

      // The edit form pre-fills the start with the *next* occurrence. If it came
      // back unchanged, keep the original anchor: re-anchoring "monthly on the
      // 31st" at its 30 Apr occurrence would move the series to the 30th.
      if (input.recurrence && current.recurrence && input.anchorLocal === toLocalInput(current.sendAt, current.timeZone)) {
        const next = firstAtOrAfter(input.recurrence, current.anchorLocal, current.timeZone, current.sendAt);
        if (next) input = { ...input, anchorLocal: current.anchorLocal, timeZone: current.timeZone, sendAt: next };
      }
      const { targets, shares, fields } = split(input);
      const decided =
        status === "pending_approval"
          ? { decidedBy: null, decidedAt: null }
          : approvesIt
            ? { decidedBy: actor.id, decidedAt: new Date() }
            : { decidedBy: current.decidedBy, decidedAt: current.decidedAt };
      await tx
        .update(reminders)
        .set({ ...fields, status, rejectionReason: null, ...decided })
        .where(eq(reminders.id, id));
      await tx.delete(reminderTargets).where(eq(reminderTargets.reminderId, id));
      await tx.insert(reminderTargets).values(targets.map((t) => ({ ...t, reminderId: id, companyId })));
      await saveShares(tx, companyId, id, actor.id, shares);
      await saveAttachments(tx, companyId, id, actor.id, files, removeAttachmentIds);
      await saveCover(tx, companyId, id, input.isTask, cover);
      await saveSubTasks(tx, companyId, actor.id, id, input, { createdBy: current.createdBy, status, ...decided });
      await notifyIfDue(tx, status, input.sendAt, "isEvent" in input && input.isEvent);
      return {
        approvers: status === "pending_approval" ? await approversToTell(tx, companyId, id) : [],
        tell: approvesIt ? await tellDecision(tx, companyId, actor.id, { id, title: input.title, createdBy: creator.id }, true) : null,
      };
    }),
  );
  if ("error" in result) return result.error;
  await notifyApprovers(companyId, result.approvers, input.title, id);
  if (result.tell) await sendTell(result.tell);
  return null;
}

// PRD 5.6 "this occurrence": a scheduled series' next occurrence becomes its
// own one-time reminder, and the series records that date as skipped and
// moves on (if the copy needs approval, only once it's approved; see
// dispatchDue). The copy keeps the series' creator, so the same people see and
// change it; files not removed in the form are copied. Approval works as an
// edit of the series would: creator and editor are both checked, and a series
// approved for these recipients (or more) passes the approval on.
// ponytail: a detached copy, not a per-occurrence override. The v2 calendar's
// "this one" can reuse it for any date by skipping that date instead.
export async function detachOccurrence(
  actor: Actor,
  companyId: string,
  id: string,
  input: ReminderInput,
  files: CheckedFile[] = [],
  removeAttachmentIds: string[] = [],
  // Any upcoming date of the series (the calendar, PRD 14.2); the next one by default.
  occursAt?: Date,
  // A calendar move: only the time changes, never the recipients, so the copy
  // keeps the series' status and approval (decided 2026-10-20, spec M6).
  moveOnly = false,
  cover?: CheckedFile | null,
) {
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const [series] = await tx
        .select()
        .from(reminders)
        .where(and(eq(reminders.id, id), isNull(reminders.deletedAt)))
        .for("update");
      if (!series || !(await mayChange(companyId, actor, series.createdBy))) throw new Refused("Reminder not found.");
      if (!series.recurrence || series.status !== "scheduled")
        throw new Refused("Only a scheduled repeating reminder can change just its next one.");
      if (input.recurrence) throw new Refused("Only the next one can't repeat.");
      const at = occursAt ?? series.sendAt;
      if (occursAt) await assertUpcoming(tx, { ...series, recurrence: series.recurrence }, occursAt);

      const creator = { id: series.createdBy, access: await loadAccess(companyId, series.createdBy) };
      const out = await checked(tx, companyId, creator, input);
      if (actor.id !== creator.id) out.push(...(await checked(tx, companyId, actor, input)));
      const oldKeys = new Set((await tx.select().from(reminderTargets).where(eq(reminderTargets.reminderId, id))).map(targetKey));
      const passOn = moveOnly || (series.decidedBy !== null && input.targets.every((t) => oldKeys.has(targetKey(t))));
      const status: ReminderStatus = out.length && !passOn ? "pending_approval" : "scheduled";

      const kept = await tx
        .select()
        .from(attachments)
        .where(and(eq(attachments.reminderId, id), removeAttachmentIds.length ? notInArray(attachments.id, removeAttachmentIds) : undefined))
        .orderBy(attachments.createdAt);
      const copies: CheckedFile[] = [];
      for (const a of kept) copies.push({ fileName: a.fileName, contentType: a.contentType, size: a.size, sha256: a.sha256, data: (await getBlob(tx, a.id))! });

      const newId = await insertReminder(
        tx,
        companyId,
        actor.id,
        {
          ...input,
          createdBy: series.createdBy,
          status,
          replacesSeriesId: id,
          replacesOccursAt: at,
          ...(status === "scheduled" && passOn ? { decidedBy: series.decidedBy, decidedAt: series.decidedAt } : {}),
        },
        [...copies, ...files],
        cover,
      );
      await copyColors(tx, id, newId);
      if (cover === undefined && input.isTask) await copyCover(tx, id, newId);
      // Waiting for approval: the series keeps that date for now. The worker
      // skips it on the day only if the copy has been approved by then
      // (decided 2026-10-19), so an unapproved change never loses a send.
      if (status === "scheduled") {
        await tx
          .insert(reminderOccurrences)
          .values({ companyId, reminderId: id, occursAt: at, status: "skipped" })
          .onConflictDoNothing();
        // A later date leaves "Next" where it is.
        if (at.getTime() === series.sendAt.getTime()) {
          const next = await nextFree(tx, { ...series, recurrence: series.recurrence }, at, false);
          await tx.update(reminders).set(next ? { sendAt: next } : { status: "sent" }).where(eq(reminders.id, id));
        }
      }
      return { id: newId, approvers: status === "pending_approval" ? await approversToTell(tx, companyId, newId) : [] };
    }),
  );
  if ("error" in result) return result;
  await notifyApprovers(companyId, result.approvers, input.title, result.id);
  return { id: result.id };
}

// PRD 14.2, personal like Google Calendar's: the viewer's own colour for a
// reminder on their calendar; nobody else's view changes. Anyone who can open
// the reminder may pick one. "" = back to the type's default.
export async function setMyColor(viewer: Actor & { email: string }, companyId: string, id: string, raw: string) {
  const color = colorFrom(raw);
  if (color === undefined) return "Pick a colour from the list.";
  const [r] = await withTenant(companyId, (tx) =>
    tx.select({ id: reminders.id, createdBy: reminders.createdBy }).from(reminders).where(and(eq(reminders.id, id), isNull(reminders.deletedAt))),
  );
  if (!r || !(await reminderAccess(companyId, viewer, r))) return "Reminder not found.";
  await withTenant(companyId, (tx) =>
    color
      ? tx
          .insert(reminderColors)
          .values({ userId: viewer.id, reminderId: id, companyId, color })
          .onConflictDoUpdate({ target: [reminderColors.userId, reminderColors.reminderId], set: { color } })
      : tx.delete(reminderColors).where(and(eq(reminderColors.userId, viewer.id), eq(reminderColors.reminderId, id))),
  );
  return null;
}

// PRD 14.2 quick create (Q1–Q4): a one-time reminder or task to yourself, by
// email, at `at`. Built as ordinary input and saved by createReminder, so the
// usual rules apply; you're always in your own scope, so it never waits for
// approval. A quick task is due an hour after it's sent (decided 2026-10-20);
// a quick event lasts an hour.
export const QUICK_TASK_DUE_MINUTES = 60;
export async function quickCreate(
  actor: Actor,
  companyId: string,
  q: { title: string; at: Date; kind: "reminder" | "task" | "event"; timeZone: string; senderName: string },
  now = new Date(),
) {
  const title = q.title.trim();
  if (!title || title.length > 200) return { error: "Title must be 1–200 characters." };
  if (q.at.getTime() <= now.getTime()) return { error: "Pick a time in the future." };
  const task = q.kind === "task";
  // An event: an hour long, told 10 minutes before (spec CL5).
  const event = q.kind === "event" ? { isEvent: true, durationMinutes: 60, allDay: false, location: null, meetingUrl: null, notifyBefore: [10] } : {};
  return createReminder(actor, companyId, {
    ...event,
    title,
    description: "",
    links: [],
    senderName: q.senderName,
    sendAt: q.at,
    recurrence: null,
    anchorLocal: toLocalInput(q.at, q.timeZone),
    timeZone: q.timeZone,
    isTask: task,
    dueAfterMinutes: task ? QUICK_TASK_DUE_MINUTES : null,
    channels: ["email"],
    tags: [],
    targets: [{ kind: "user", ref: actor.id }],
    shares: [],
  });
}

// PRD 14.2 duplicate: a one-time copy at `at` with the same content,
// recipients, channels, task settings, files and sharing. It belongs
// to whoever duplicates it, so approval is checked as them (PRD 5.2): copying
// an admin's company-wide reminder as a member needs approval. Comments,
// history and completion aren't copied. Anyone who can create reminders may
// duplicate one they can open (they've seen its content anyway).
export async function duplicateReminder(actor: Actor & { email: string }, companyId: string, id: string, at: Date, now = new Date()) {
  if (!can(actor.access, "reminders.create")) return { error: "You can't create reminders." };
  if (at.getTime() <= now.getTime()) return { error: "Pick a time in the future." };
  const [orig] = await withTenant(companyId, (tx) =>
    tx.select().from(reminders).where(and(eq(reminders.id, id), isNull(reminders.deletedAt))),
  );
  if (!orig || !(await reminderAccess(companyId, actor, orig))) return { error: "Reminder not found." };
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const input: ReminderInput = { ...(await inputFromRow(tx, orig)), sendAt: at, recurrence: null, anchorLocal: toLocalInput(at, orig.timeZone) };
      const out = await checked(tx, companyId, actor, input);
      const status: ReminderStatus = out.length ? "pending_approval" : "scheduled";
      const files = await filesOf(tx, id);
      const newId = await insertReminder(tx, companyId, actor.id, { ...input, createdBy: actor.id, status }, files);
      await copyCover(tx, id, newId);
      return { id: newId, approvers: status === "pending_approval" ? await approversToTell(tx, companyId, newId) : [] };
    }),
  );
  if ("error" in result) return result;
  await notifyApprovers(companyId, result.approvers, orig.title, result.id);
  return { id: result.id };
}

// --- The calendar's move, edit and delete (PRD 14.2, M1–M14) ---------------------

type Series = typeof reminders.$inferSelect & { recurrence: Rule };

// `at` must be one of the series' dates still to come: not before its next
// one, not past, and not already recorded (skipped or sent).
async function assertUpcoming(tx: Tx, r: Series, at: Date, now = new Date()) {
  if (at < r.sendAt || at <= now) throw new Refused("That date has already gone.");
  if (firstAtOrAfter(r.recurrence, r.anchorLocal, r.timeZone, at)?.getTime() !== at.getTime())
    throw new Refused("That isn't one of this reminder's dates.");
  const [taken] = await tx
    .select({ id: reminderOccurrences.id })
    .from(reminderOccurrences)
    .where(and(eq(reminderOccurrences.reminderId, r.id), eq(reminderOccurrences.occursAt, at)));
  if (taken) throw new Refused("That date is already skipped or sent.");
}

// The series' first date at/after `from` (or after it) that isn't recorded yet.
async function nextFree(tx: Tx, r: Series, from: Date, inclusive: boolean) {
  const taken = new Set(
    (await tx.select({ at: reminderOccurrences.occursAt }).from(reminderOccurrences).where(and(eq(reminderOccurrences.reminderId, r.id), gte(reminderOccurrences.occursAt, from)))).map(
      (o) => o.at.getTime(),
    ),
  );
  let next = inclusive ? firstAtOrAfter(r.recurrence, r.anchorLocal, r.timeZone, from) : nextAfter(r.recurrence, r.anchorLocal, r.timeZone, from);
  while (next && taken.has(next.getTime())) next = nextAfter(r.recurrence, r.anchorLocal, r.timeZone, next);
  return next;
}

// A reminder row as input again (for a copy or a split): same content,
// recipients, channels, task settings and sharing.
async function inputFromRow(tx: Tx, r: typeof reminders.$inferSelect): Promise<ReminderInput> {
  const targets = (await tx.select().from(reminderTargets).where(eq(reminderTargets.reminderId, r.id))).map(({ kind, ref, label }) => ({ kind, ref, label }));
  const shares = await tx.select({ kind: reminderShares.kind, ref: reminderShares.ref }).from(reminderShares).where(eq(reminderShares.reminderId, r.id));
  return {
    title: r.title,
    description: r.description,
    links: r.links,
    senderName: r.senderName,
    sendAt: r.sendAt,
    recurrence: r.recurrence as Rule | null,
    anchorLocal: r.anchorLocal,
    timeZone: r.timeZone,
    isTask: r.isTask,
    dueAfterMinutes: r.dueAfterMinutes,
    channels: r.channels,
    tags: r.tags,
    targets,
    shares,
    isEvent: r.isEvent,
    durationMinutes: r.durationMinutes,
    allDay: r.allDay,
    location: r.location,
    meetingUrl: r.meetingUrl,
    notifyBefore: r.notifyBefore,
  };
}

async function filesOf(tx: Tx, reminderId: string) {
  const files: CheckedFile[] = [];
  for (const a of await tx.select().from(attachments).where(eq(attachments.reminderId, reminderId)).orderBy(attachments.createdAt))
    files.push({ fileName: a.fileName, contentType: a.contentType, size: a.size, sha256: a.sha256, data: (await getBlob(tx, a.id))! });
  return files;
}

export type Scope = "one" | "following" | "all";

// Everyone's own colour (PRD 14.2, personal) for a reminder, onto its copy or
// split, so nobody's calendar changes colour (decided 2026-10-20, spec M7).
const copyColors = (tx: Tx, from: string, to: string) =>
  tx.execute(sql`insert into reminder_colors (user_id, reminder_id, company_id, color)
    select user_id, ${to}, company_id, color from reminder_colors where reminder_id = ${from} on conflict do nothing`);

// PRD 14.2: drag (or "Move to…") an entry. A one-time reminder just moves;
// its recipients and approval stay. For a series:
// - one: that date becomes its own one-time reminder (detachOccurrence) and the series skips it;
// - following: the series ends before that date and a new series starts at the new time,
//   with the same rule (moved the same way), content, recipients, files, sharing and approval;
// - all: the whole series shifts by the same amount; what was already sent stays as it was.
// Waiting for approval: one-time ones and "all" move; "one"/"following" wait for the approval.
// Returns the reminder that now holds that date.
export async function moveEntry(actor: Actor, companyId: string, id: string, occursAt: Date, newAt: Date, scope: Scope, now = new Date()) {
  if (newAt.getTime() <= now.getTime()) return { error: "Pick a time in the future." };
  const [row] = await withTenant(companyId, (tx) => tx.select().from(reminders).where(and(eq(reminders.id, id), isNull(reminders.deletedAt))));
  if (!row || !(await mayChange(companyId, actor, row.createdBy))) return { error: "Reminder not found." };
  if (row.recurrence && scope === "one") {
    if (row.status !== "scheduled") return { error: "Only a scheduled repeating reminder can move just one date." };
    const input = await withTenant(companyId, (tx) => inputFromRow(tx, row));
    return detachOccurrence(actor, companyId, id, { ...input, recurrence: null, sendAt: newAt, anchorLocal: toLocalInput(newAt, row.timeZone) }, [], [], occursAt, true);
  }
  return refusals(() =>
    withTenant(companyId, async (tx) => {
      const [r] = await tx.select().from(reminders).where(and(eq(reminders.id, id), isNull(reminders.deletedAt))).for("update");
      if (!r) throw new Refused("Reminder not found.");
      notSubTask(r);
      const local = (d: Date) => toLocalInput(d, r.timeZone);
      if (!r.recurrence) {
        if (r.status !== "scheduled" && r.status !== "pending_approval") throw new Refused("This reminder can no longer be moved.");
        await tx.update(reminders).set({ sendAt: newAt, anchorLocal: local(newAt) }).where(eq(reminders.id, id));
        await toSubTasks(tx, id, { sendAt: newAt, anchorLocal: local(newAt) });
        await notifyIfDue(tx, r.status, newAt);
        return { id };
      }
      const series: Series = { ...r, recurrence: r.recurrence };
      if (scope === "all") {
        if (!["scheduled", "pending_approval", "paused"].includes(r.status)) throw new Refused("This reminder can no longer be moved.");
        if (firstAtOrAfter(series.recurrence, r.anchorLocal, r.timeZone, occursAt)?.getTime() !== occursAt.getTime())
          throw new Refused("That isn't one of this reminder's dates.");
        const moved = shiftSeries(series.recurrence, r.anchorLocal, local(occursAt), local(newAt));
        // Upcoming skips (and the dates waiting copies replace) move with the
        // series, or a date moved with "this one" would send twice.
        const shift = (d: Date) => zonedToUtc(shiftSeries(series.recurrence, local(d), local(occursAt), local(newAt)).anchorLocal, r.timeZone)!;
        for (const o of await tx
          .select({ id: reminderOccurrences.id, at: reminderOccurrences.occursAt })
          .from(reminderOccurrences)
          .where(and(eq(reminderOccurrences.reminderId, id), eq(reminderOccurrences.status, "skipped"), gte(reminderOccurrences.occursAt, now))))
          await tx.update(reminderOccurrences).set({ occursAt: shift(o.at) }).where(eq(reminderOccurrences.id, o.id));
        for (const c of await tx
          .select({ id: reminders.id, at: reminders.replacesOccursAt })
          .from(reminders)
          .where(and(eq(reminders.replacesSeriesId, id), gte(reminders.replacesOccursAt, now))))
          await tx.update(reminders).set({ replacesOccursAt: shift(c.at!) }).where(eq(reminders.id, c.id));
        const next = await nextFree(tx, { ...series, ...moved, recurrence: moved.rule }, now, true);
        await tx
          .update(reminders)
          .set({ recurrence: moved.rule, anchorLocal: moved.anchorLocal, ...(next ? { sendAt: next } : { status: "sent" }) })
          .where(eq(reminders.id, id));
        if (next) await notifyIfDue(tx, r.status, next);
        return { id };
      }
      // following
      if (r.status !== "scheduled") throw new Refused("Only a scheduled repeating reminder can be split.");
      await assertUpcoming(tx, series, occursAt, now);
      const { before, after } = splitRule(series.recurrence, r.anchorLocal, r.timeZone, occursAt);
      const moved = shiftSeries(after, local(occursAt), local(occursAt), local(newAt));
      const input = await inputFromRow(tx, r);
      const newId = await insertReminder(
        tx,
        companyId,
        actor.id,
        {
          ...input,
          recurrence: moved.rule,
          anchorLocal: moved.anchorLocal,
          sendAt: newAt,
          createdBy: r.createdBy,
          status: "scheduled",
          decidedBy: r.decidedBy,
          decidedAt: r.decidedAt,
        },
        await filesOf(tx, id),
      );
      await copyColors(tx, id, newId);
      await copyCover(tx, id, newId);
      // Skips from that date on, and the dates waiting copies replace, go to the
      // new series (moved the same way), so no date sends twice.
      const shift = (d: Date) => zonedToUtc(shiftSeries(series.recurrence, local(d), local(occursAt), local(newAt)).anchorLocal, r.timeZone)!;
      for (const o of await tx
        .select({ id: reminderOccurrences.id, at: reminderOccurrences.occursAt })
        .from(reminderOccurrences)
        .where(and(eq(reminderOccurrences.reminderId, id), eq(reminderOccurrences.status, "skipped"), gte(reminderOccurrences.occursAt, occursAt))))
        await tx.update(reminderOccurrences).set({ reminderId: newId, occursAt: shift(o.at) }).where(eq(reminderOccurrences.id, o.id));
      for (const c of await tx
        .select({ id: reminders.id, at: reminders.replacesOccursAt })
        .from(reminders)
        .where(and(eq(reminders.replacesSeriesId, id), gte(reminders.replacesOccursAt, occursAt))))
        await tx.update(reminders).set({ replacesSeriesId: newId, replacesOccursAt: shift(c.at!) }).where(eq(reminders.id, c.id));
      await endBefore(tx, series, before);
      return { id: newId };
    }),
  );
}

// The series stops before the split: it keeps `before`'s dates (nothing left
// to send = finished); with none at all it never sent anything, so it goes.
async function endBefore(tx: Tx, r: Series, before: Rule | null) {
  if (!before) {
    await tx.update(reminders).set({ deletedAt: new Date(), status: "cancelled" }).where(eq(reminders.id, r.id));
    await tx.delete(notifications).where(eq(notifications.reminderId, r.id));
    return;
  }
  const next = await nextFree(tx, { ...r, recurrence: before }, r.sendAt, true);
  await tx
    .update(reminders)
    .set({ recurrence: before, ...(next ? { sendAt: next } : { status: "sent" }) })
    .where(eq(reminders.id, r.id));
}

// PRD 14.2 / 5.6: delete from the calendar. One-time, or "all": the reminder
// goes (hidden everywhere, deleteReminder). A series' "one" skips that date;
// "following" ends the series before it.
export async function deleteEntry(actor: Actor, companyId: string, id: string, occursAt: Date, scope: Scope, now = new Date()) {
  const [row] = await withTenant(companyId, (tx) => tx.select().from(reminders).where(and(eq(reminders.id, id), isNull(reminders.deletedAt))));
  if (!row || !(await mayChange(companyId, actor, row.createdBy))) return "Reminder not found.";
  if (!row.recurrence || scope === "all") return deleteReminder(actor, companyId, id);
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const [r] = await tx.select().from(reminders).where(eq(reminders.id, id)).for("update");
      if (r.status !== "scheduled" && r.status !== "paused") throw new Refused("Only an upcoming repeating reminder can lose a date.");
      const series: Series = { ...r, recurrence: r.recurrence! };
      await assertUpcoming(tx, series, occursAt, now);
      if (scope === "one") {
        await tx.insert(reminderOccurrences).values({ companyId, reminderId: id, occursAt, status: "skipped" }).onConflictDoNothing();
        if (occursAt.getTime() === r.sendAt.getTime()) {
          const next = await nextFree(tx, series, occursAt, false);
          await tx.update(reminders).set(next ? { sendAt: next } : { status: "sent" }).where(eq(reminders.id, id));
        }
        return null;
      }
      await endBefore(tx, series, splitRule(series.recurrence, r.anchorLocal, r.timeZone, occursAt).before);
      return null;
    }),
  );
  return result && "error" in result ? result.error : null;
}

// Group members were added (PRD 4): a scheduled reminder to that group whose
// creator couldn't send to one of the new people without approval goes back
// to pending_approval, and approvers are told. Otherwise a member could send
// to an in-scope group and widen it afterwards. Returns how many flipped.
export async function recheckGroupReminders(companyId: string, groupId: string, addedUserIds: string[]) {
  if (!addedUserIds.length) return 0;
  const flipped = await withTenant(companyId, async (tx) => {
    const affected = await tx
      .select({ id: reminders.id, title: reminders.title, createdBy: reminders.createdBy, parentId: reminders.parentId })
      .from(reminders)
      .innerJoin(reminderTargets, eq(reminderTargets.reminderId, reminders.id))
      .where(and(eq(reminderTargets.kind, "group"), eq(reminderTargets.ref, groupId), inArray(reminders.status, ["scheduled", "paused"])))
      .for("update", { of: reminders });
    const added = await tx.select({ email: user.email }).from(user).where(inArray(user.id, addedUserIds));
    const addedEmails = new Set(added.map((a) => a.email.toLowerCase()));
    const out: { id: string; title: string; approvers: Approver[] }[] = [];
    for (const r of affected) {
      const targets = await tx.select().from(reminderTargets).where(eq(reminderTargets.reminderId, r.id));
      const creator = { id: r.createdBy, access: await loadAccess(companyId, r.createdBy) };
      const reasons = await outOfScope(tx, companyId, creator, targets, await resolveRecipients(tx, companyId, targets));
      if (!reasons.some((x) => addedEmails.has(x))) continue;
      // A sub-task goes back with its whole task (ST8); the approvers review the task.
      const top = r.parentId ?? r.id;
      if (out.some((o) => o.id === top)) continue;
      await tx
        .update(reminders)
        .set({ status: "pending_approval", decidedBy: null, decidedAt: null })
        .where(and(or(eq(reminders.id, top), eq(reminders.parentId, top)), inArray(reminders.status, ["scheduled", "paused"])));
      out.push({ id: top, title: r.title, approvers: await approversToTell(tx, companyId, top) });
    }
    return out;
  });
  for (const r of flipped) await notifyApprovers(companyId, r.approvers, r.title, r.id);
  return flipped.length;
}

export async function cancelReminder(actor: Actor, companyId: string, id: string) {
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const [current] = await tx.select().from(reminders).where(eq(reminders.id, id)).for("update");
      if (!current || !(await mayChange(companyId, actor, current.createdBy))) throw new Refused("Reminder not found.");
      notSubTask(current);
      if (!EDITABLE.includes(current.status)) throw new Refused("This reminder can no longer be cancelled.");
      await tx.update(reminders).set({ status: "cancelled" }).where(eq(reminders.id, id));
      await toSubTasks(tx, id, { status: "cancelled" });
      await cancelWaiting(tx, companyId, id);
      return null;
    }),
  );
  return result && "error" in result ? result.error : null;
}

// Soft delete (PRD 5.6), any status. Hidden everywhere from then on (decided
// 2026-10-19: no restore). It's also cancelled, so the worker, follow-ups,
// digests and reports, which already skip cancelled ones, leave it alone.
// The audit trigger records deleted_at; retention purges it later.
export async function deleteReminder(actor: Actor, companyId: string, id: string) {
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const [current] = await tx
        .select()
        .from(reminders)
        .where(and(eq(reminders.id, id), isNull(reminders.deletedAt)))
        .for("update");
      if (!current || !(await mayChange(companyId, actor, current.createdBy))) throw new Refused("Reminder not found.");
      notSubTask(current);
      // With its sub-tasks (ST11).
      const family = [id, ...(await tx.select({ id: reminders.id }).from(reminders).where(eq(reminders.parentId, id))).map((k) => k.id)];
      const [busy] = await tx
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(and(inArray(deliveries.reminderId, family), inArray(deliveries.status, ["queued", "sending"])))
        .limit(1);
      if (busy) throw new Refused("It's being sent right now. Try again once it's done.");
      await tx.update(reminders).set({ status: "cancelled", deletedAt: new Date() }).where(and(inArray(reminders.id, family), isNull(reminders.deletedAt)));
      await tx.update(taskAssignments).set({ snoozedUntil: null }).where(inArray(taskAssignments.reminderId, family));
      await tx.delete(notifications).where(inArray(notifications.reminderId, family));
      await cancelWaiting(tx, companyId, id);
      return null;
    }),
  );
  return result && "error" in result ? result.error : null;
}

// PRD 5.8: the single "done" of a sent occurrence nobody in the company is
// assigned to: a task sent only to outside addresses (the shared toggle), or
// an announcement (the creator's "mark complete"). Same people as editing.
export async function setOccurrenceDone(actor: Actor, companyId: string, occurrenceId: string, done: boolean) {
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const [o] = await tx
        .select({ status: reminderOccurrences.status, createdBy: reminders.createdBy, reminderId: reminders.id, parentId: reminders.parentId })
        .from(reminderOccurrences)
        .innerJoin(reminders, eq(reminders.id, reminderOccurrences.reminderId))
        .where(and(eq(reminderOccurrences.id, occurrenceId), isNull(reminders.deletedAt)))
        .for("update", { of: reminderOccurrences });
      if (!o || !(await mayChange(companyId, actor, o.createdBy))) throw new Refused("Reminder not found.");
      if (o.status !== "sent" && o.status !== "sending") throw new Refused("It hasn't been sent yet.");
      const [assigned] = await tx.select({ id: taskAssignments.id }).from(taskAssignments).where(eq(taskAssignments.occurrenceId, occurrenceId)).limit(1);
      if (assigned) throw new Refused("Each assignee marks this one done themselves.");
      const [sub] = await tx.select({ id: reminders.id }).from(reminders).where(and(eq(reminders.parentId, o.reminderId), isNull(reminders.deletedAt))).limit(1);
      if (sub) throw new Refused("It’s done once all its sub-tasks are."); // ST4
      await tx.update(reminderOccurrences).set({ doneAt: done ? new Date() : null }).where(eq(reminderOccurrences.id, occurrenceId));
      if (done) await startAfter(tx, o.reminderId); // CH4
      return o.parentId ? syncParent(tx, companyId, o.parentId) : null;
    }),
  );
  if (result && "error" in result) return result.error;
  if (result) await sendTell(result);
  return null;
}

// Checks reminders.approve and, in named mode, that the actor is named.
export async function decideReminder(actor: Actor, companyId: string, id: string, approve: boolean, reason = "") {
  reason = reason.trim();
  if (!(await mayDecide(companyId, actor))) return "Only the named approvers can decide this.";
  if (!approve && !reason) return "Give a reason for rejecting.";
  if (reason.length > 500) return "Reason must be at most 500 characters.";
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const [current] = await tx.select().from(reminders).where(eq(reminders.id, id)).for("update");
      if (!current) throw new Refused("Reminder not found.");
      notSubTask(current);
      if (current.status !== "pending_approval") throw new Refused("This reminder isn't waiting for approval.");
      const set = { status: approve ? ("scheduled" as const) : ("rejected" as const), decidedBy: actor.id, decidedAt: new Date(), rejectionReason: approve ? null : reason };
      await tx.update(reminders).set(set).where(eq(reminders.id, id));
      await toSubTasks(tx, id, set);
      if (approve) await notifyIfDue(tx, "scheduled", current.sendAt, current.isEvent);
      return { tell: await tellDecision(tx, companyId, actor.id, current, approve, reason) };
    }),
  );
  if ("error" in result) return result.error;
  await sendTell(result.tell);
  return null;
}

// The creator hears that their reminder was approved or rejected: in the app
// always; by email or Slack as they chose (PRD 7.5). Inside the transaction.
async function tellDecision(
  tx: Tx,
  companyId: string,
  actorId: string,
  r: { id: string; title: string; createdBy: string },
  approve: boolean,
  reason = "",
) {
  await addNotifications(tx, [
    { companyId, userId: r.createdBy, kind: "decided", reminderId: r.id, actorId, text: approve ? "Approved" : `Rejected: ${reason}` },
  ]);
  const link = { label: "Open the reminder", url: `${process.env.BETTER_AUTH_URL}/reminders/${r.id}` };
  return planTell(
    tx,
    companyId,
    [r.createdBy],
    approve ? "approved" : "decided",
    approve
      ? { subject: `Approved: ${r.title}`, text: `Your reminder "${r.title}" was approved and is scheduled.`, link }
      : {
          subject: `Not approved: ${r.title}`,
          text: `Your reminder "${r.title}" wasn't approved.\n\nReason: ${reason}\n\nYou can edit it and submit it again.`,
          link,
        },
  );
}

// --- Reading -----------------------------------------------------------------

// PRD 5.4, the parts that exist so far: creator, view_all, approvers, managers
// of a department the creator is in, and anyone it was delivered to.
// "full" = may see the delivery log; recipients only see the reminder itself.
export async function reminderAccess(
  companyId: string,
  viewer: Actor & { email: string },
  r: { id: string; createdBy: string },
): Promise<"full" | "viewer" | null> {
  if (await canSeeReminder(companyId, viewer, r.createdBy)) return "full";
  const [got] = await withTenant(companyId, (tx) =>
    tx
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.reminderId, r.id),
          // Slack DMs carry user_id; email deliveries may be to a typed address.
          or(
            eq(deliveries.userId, viewer.id),
            and(eq(deliveries.channel, "email"), eq(deliveries.address, viewer.email.toLowerCase())),
          ),
        ),
      )
      .limit(1),
  );
  if (got) return "viewer";
  if (await sharedWith(companyId, viewer.id, r.id)) return "viewer";
  const [invited] = await withTenant(companyId, (tx) =>
    tx.select({ id: reminders.id }).from(reminders).where(and(eq(reminders.id, r.id), invitedSql(viewer.id))).limit(1),
  );
  if (invited) return "viewer";
  // A manager told that someone is late on it (src/worker/escalation.ts).
  const [told] = await withTenant(companyId, (tx) =>
    tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.reminderId, r.id), eq(notifications.userId, viewer.id), eq(notifications.kind, "escalated")))
      .limit(1),
  );
  return told ? "viewer" : null;
}

// Shared with the whole company, a department I'm in, or a group I'm in.
// The SQL twin for lists is in src/lib/views.ts (canViewWhere).
async function sharedWith(companyId: string, userId: string, reminderId: string) {
  const [row] = await withTenant(companyId, (tx) =>
    tx
      .select({ one: sql`1` })
      .from(reminderShares)
      .where(and(eq(reminderShares.reminderId, reminderId), sharedWithSql(userId)))
      .limit(1),
  );
  return Boolean(row);
}

// PRD 14.3 (VS1, VS2): guests of an event and assignees of a task can open it
// once it's scheduled (not while it waits for approval), before anything is
// sent, so they can see what's coming and answer. Addressed to them by the
// targets: directly, a department or group they're in, or the whole company.
// SQL twin of the check in reminderAccess; canViewWhere uses it too.
export const invitedSql = (userId: string) => sql`((${reminders.isEvent} or ${reminders.isTask})
  and ${reminders.status} in ('scheduled', 'paused', 'sending', 'sent')
  and exists (select 1 from reminder_targets t where t.reminder_id = ${reminders.id} and (
    t.kind = 'company' or (t.kind = 'user' and t.ref = ${userId})
    or (t.kind = 'department' and t.ref in (select department_id::text from department_members where user_id = ${userId}))
    or (t.kind = 'group' and t.ref in (select group_id::text from group_members where user_id = ${userId})))))`;

export const sharedWithSql = (userId: string) =>
  sql`(${reminderShares.kind} = 'company'
    or (${reminderShares.kind} = 'department' and ${reminderShares.ref} in (select department_id::text from department_members where user_id = ${userId}))
    or (${reminderShares.kind} = 'group' and ${reminderShares.ref} in (select group_id::text from group_members where user_id = ${userId})))`;

export async function canSeeReminder(companyId: string, viewer: Actor, createdBy: string) {
  // Approvers must be able to open what they're asked to review.
  if (viewer.id === createdBy || can(viewer.access, "reminders.view_all") || can(viewer.access, "reminders.approve"))
    return true;
  const creatorM = aliasedTable(departmentMembers, "creator_m");
  const [row] = await withTenant(companyId, (tx) =>
    tx
      .select({ one: sql`1` })
      .from(departmentMembers)
      .innerJoin(creatorM, eq(creatorM.departmentId, departmentMembers.departmentId))
      .where(
        and(eq(departmentMembers.userId, viewer.id), eq(departmentMembers.isManager, true), eq(creatorM.userId, createdBy)),
      )
      .limit(1),
  );
  return Boolean(row);
}

export async function getReminder(companyId: string, id: string) {
  return withTenant(companyId, async (tx) => {
    const [r] = await tx
      .select({ reminder: reminders, creatorName: user.name, creatorEmail: user.email })
      .from(reminders)
      .innerJoin(user, eq(user.id, reminders.createdBy))
      .where(and(eq(reminders.id, id), isNull(reminders.deletedAt)));
    if (!r) return null;
    const targets = await tx.select().from(reminderTargets).where(eq(reminderTargets.reminderId, id));
    const deptIds = targets.filter((t) => t.kind === "department").map((t) => t.ref!);
    const userIds = targets.filter((t) => t.kind === "user").map((t) => t.ref!);
    const deptNames = deptIds.length
      ? await tx.select({ id: departments.id, name: departments.name }).from(departments).where(inArray(departments.id, deptIds))
      : [];
    const userNames = userIds.length
      ? await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds))
      : [];
    const groupIds = targets.filter((t) => t.kind === "group").map((t) => t.ref!);
    const groupNames = groupIds.length
      ? await tx.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, groupIds))
      : [];
    const label = (t: Target) =>
      t.kind === "company"
        ? "Everyone in the company"
        : t.kind === "department"
          ? `${deptNames.find((d) => d.id === t.ref)?.name ?? "Deleted department"} (department)`
          : t.kind === "group"
            ? `${groupNames.find((g) => g.id === t.ref)?.name ?? "Deleted"} (group)`
            : t.kind === "user"
            ? (userNames.find((u) => u.id === t.ref)?.name ?? "Removed person")
            : t.kind === "slack_channel"
              ? `#${t.label ?? t.ref} (Slack)`
              : t.ref!;

    // Typed outside addresses that unsubscribed (PRD 7.1): shown on the reminder.
    const emailRefs = targets.filter((t) => t.kind === "email").map((t) => t.ref!);
    const unsubscribed = emailRefs.length
      ? (await tx.select({ email: emailSuppressions.email }).from(emailSuppressions).where(inArray(emailSuppressions.email, emailRefs))).map((x) => x.email)
      : [];

    // Why it needs approval, recomputed with the creator's own access.
    let outOfScopeList: string[] = [];
    if (r.reminder.status === "pending_approval") {
      const creator = { id: r.reminder.createdBy, access: await loadAccess(companyId, r.reminder.createdBy) };
      outOfScopeList = await outOfScope(tx, companyId, creator, targets, await resolveRecipients(tx, companyId, targets));
    }
    const shares = await tx.select({ kind: reminderShares.kind, ref: reminderShares.ref }).from(reminderShares).where(eq(reminderShares.reminderId, id));
    const shareDepts = shares.filter((x) => x.kind === "department").map((x) => x.ref!);
    const shareGroups = shares.filter((x) => x.kind === "group").map((x) => x.ref!);
    const [sd, sg] = await Promise.all([
      shareDepts.length ? tx.select({ id: departments.id, name: departments.name }).from(departments).where(inArray(departments.id, shareDepts)) : [],
      shareGroups.length ? tx.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, shareGroups)) : [],
    ]);
    const shareLabels = shares.map((x) =>
      x.kind === "company"
        ? "Everyone in the company"
        : x.kind === "department"
          ? `${sd.find((d) => d.id === x.ref)?.name ?? "Deleted"} (department)`
          : `${sg.find((g) => g.id === x.ref)?.name ?? "Deleted"} (group)`,
    );
    return {
      ...r.reminder,
      creatorName: r.creatorName,
      creatorEmail: r.creatorEmail,
      targets,
      targetLabels: targets.map(label),
      outOfScope: outOfScopeList,
      unsubscribed,
      shares,
      shareLabels,
    };
  });
}

export function listPendingApprovals(companyId: string) {
  return withTenant(companyId, (tx) =>
    tx
      .select({ id: reminders.id, title: reminders.title, sendAt: reminders.sendAt, creatorName: user.name })
      .from(reminders)
      .innerJoin(user, eq(user.id, reminders.createdBy))
      .where(and(eq(reminders.status, "pending_approval"), isNull(reminders.parentId)))
      .orderBy(reminders.sendAt),
  );
}

// Due but not picked up: the worker isn't running (or is far behind). The worker
// sends within seconds and its tick runs every minute, so a minute late means
// something is wrong. "sending" stuck 2 minutes = deliveries queued, nobody sending.
export function isDelayed(r: { status: ReminderStatus; sendAt: Date; updatedAt: Date }, now = new Date()) {
  const ago = (d: Date) => now.getTime() - d.getTime();
  return (r.status === "scheduled" && ago(r.sendAt) > 60_000) || (r.status === "sending" && ago(r.updatedAt) > 120_000);
}

// A series that has run out says "Ended" rather than "Sent".
// One waiting for a task (PRD 14.5) says "Waiting".
export const statusLabel = (r: { status: ReminderStatus; recurrence: Rule | null; sendAt?: Date }) =>
  r.recurrence && r.status === "sent" ? "Ended" : r.status === "scheduled" && r.sendAt && isWaiting({ sendAt: r.sendAt }) ? "Waiting" : STATUS_LABELS[r.status];

export const STATUS_LABELS: Record<ReminderStatus, string> = {
  pending_approval: "Needs approval",
  paused: "Paused",
  rejected: "Not approved",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  cancelled: "Cancelled",
};

// The latest occurrence's per-person log, plus the last 10 occurrences.
export async function deliveryLog(companyId: string, reminderId: string) {
  return withTenant(companyId, async (tx) => {
    const history = await tx
      .select({
        id: reminderOccurrences.id,
        occursAt: reminderOccurrences.occursAt,
        status: reminderOccurrences.status,
        dueAt: reminderOccurrences.dueAt,
        snapshot: reminderOccurrences.snapshot,
        doneAt: reminderOccurrences.doneAt,
        sent: sql<number>`count(*) filter (where ${deliveries.status} = 'sent')::int`,
        failed: sql<number>`count(*) filter (where ${deliveries.status} = 'failed')::int`,
        pending: sql<number>`count(*) filter (where ${deliveries.status} in ('queued','sending'))::int`,
      })
      .from(reminderOccurrences)
      .leftJoin(deliveries, eq(deliveries.occurrenceId, reminderOccurrences.id))
      .where(eq(reminderOccurrences.reminderId, reminderId))
      .groupBy(reminderOccurrences.id)
      .orderBy(desc(reminderOccurrences.occursAt))
      .limit(10);
    const latest = history.find((o) => o.status === "sending" || o.status === "sent");
    const select = (where: SQL) =>
      tx
        .select({
          id: deliveries.id,
          channel: deliveries.channel,
          address: deliveries.address,
          userName: user.name,
          status: deliveries.status,
          sentAt: deliveries.sentAt,
          lastError: deliveries.lastError,
          attempts: deliveries.attempts,
          kind: deliveries.kind,
        })
        .from(deliveries)
        .leftJoin(user, eq(user.id, deliveries.userId))
        .where(where)
        .orderBy(deliveries.channel, deliveries.address);
    const rows = latest ? await select(eq(deliveries.occurrenceId, latest.id)) : [];
    // An event's invites (PRD 14.3): one per guest, not per date.
    const invites = await select(and(eq(deliveries.reminderId, reminderId), eq(deliveries.kind, "invite"))!);
    // "Starts soon" notices (events) or "remind before due" (tasks) for the latest date that had any.
    const [last] = await tx
      .select({ at: deliveries.occursAt })
      .from(deliveries)
      .where(and(eq(deliveries.reminderId, reminderId), inArray(deliveries.kind, ["soon", "due"])))
      .orderBy(desc(deliveries.occursAt))
      .limit(1);
    const notices = last?.at
      ? { at: last.at, rows: await select(and(eq(deliveries.reminderId, reminderId), inArray(deliveries.kind, ["soon", "due"]), eq(deliveries.occursAt, last.at))!) }
      : null;
    // Change notices (slice 4), newest version first.
    const changed = (await select(and(eq(deliveries.reminderId, reminderId), inArray(deliveries.kind, ["update", "cancel", "uninvite"]))!)).sort(
      (a, b) => (b.sentAt?.getTime() ?? Infinity) - (a.sentAt?.getTime() ?? Infinity),
    );
    return { latest: latest ?? null, rows, invites, notices, changed, history };
  });
}

// --- Series controls (recurring only; creator or reminders.edit) --------------

async function seriesChange(
  actor: Actor,
  companyId: string,
  id: string,
  change: (tx: Tx, r: typeof reminders.$inferSelect & { recurrence: Rule }) => Promise<Partial<typeof reminders.$inferInsert>>,
) {
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const [r] = await tx.select().from(reminders).where(eq(reminders.id, id)).for("update");
      if (!r || !(await mayChange(companyId, actor, r.createdBy))) throw new Refused("Reminder not found.");
      if (!r.recurrence) throw new Refused("Only repeating reminders can do that.");
      const set = await change(tx, { ...r, recurrence: r.recurrence });
      await tx.update(reminders).set(set).where(eq(reminders.id, id));
      await notifyIfDue(tx, set.status ?? r.status, set.sendAt ?? r.sendAt);
      return null;
    }),
  );
  return result && "error" in result ? result.error : null;
}

export const pauseReminder = (actor: Actor, companyId: string, id: string) =>
  seriesChange(actor, companyId, id, async (_tx, r) => {
    if (r.status !== "scheduled") throw new Refused("Only a scheduled reminder can be paused.");
    return { status: "paused" };
  });

// Picks up at the next occurrence from now; nothing missed while paused is sent.
// Steps over occurrences already recorded (e.g. skipped before pausing), so
// "Next" never shows one that won't go out.
export const resumeReminder = (actor: Actor, companyId: string, id: string) =>
  seriesChange(actor, companyId, id, async (tx, r) => {
    if (r.status !== "paused") throw new Refused("This reminder isn't paused.");
    const now = new Date();
    const taken = new Set(
      (
        await tx
          .select({ at: reminderOccurrences.occursAt })
          .from(reminderOccurrences)
          .where(and(eq(reminderOccurrences.reminderId, r.id), gte(reminderOccurrences.occursAt, now)))
      ).map((o) => o.at.getTime()),
    );
    let next = firstAtOrAfter(r.recurrence, r.anchorLocal, r.timeZone, now);
    while (next && taken.has(next.getTime())) next = nextAfter(r.recurrence, r.anchorLocal, r.timeZone, next);
    return next ? { status: "scheduled", sendAt: next } : { status: "sent" };
  });

// Records the next occurrence as skipped (so the worker won't send it) and moves on.
export const skipNextOccurrence = (actor: Actor, companyId: string, id: string) =>
  seriesChange(actor, companyId, id, async (tx, r) => {
    if (r.status !== "scheduled" && r.status !== "paused") throw new Refused("Nothing to skip.");
    await tx
      .insert(reminderOccurrences)
      .values({ companyId, reminderId: r.id, occursAt: r.sendAt, status: "skipped" })
      .onConflictDoNothing();
    const next = nextAfter(r.recurrence, r.anchorLocal, r.timeZone, r.sendAt);
    return next ? { sendAt: next } : { status: "sent" };
  });
