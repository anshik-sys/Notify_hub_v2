import { randomBytes } from "node:crypto";
import { aliasedTable, and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { attachments, deliveries, departmentMembers, departments, reminderOccurrences, reminders, reminderTargets, roles, user, userRoles, type ReminderStatus } from "@/db/schema";
import { type CheckedFile, MAX_FILES_PER_REMINDER } from "./attachments";
import { sendMail } from "./mail";
import { addNotifications, mutedFor } from "./notifications";
import { putBlob } from "./storage";
import { resolveRecipients, type Target, type Tx } from "./recipients";
import { type Access, can, COMPANY_ADMIN_ROLE_ID, loadAccess } from "./permissions";
import { firstAtOrAfter, nextAfter, type RepeatFields, type Rule, ruleFromForm } from "./recurrence";
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
  targets: Target[];
};
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
  userIds: string[];
  emails: string;
  when: string; // "now" | "later"
  sendAtLocal: string;
  repeat: RepeatFields;
  isTask: boolean;
  dueLocal: string;
  channels: string[]; // "email" | "slack"
  slackChannelIds: string[];
};

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
        ...[...new Set(raw.userIds)].map((ref) => ({ kind: "user" as const, ref })),
      ];
  targets.push(...emails.map((ref) => ({ kind: "email" as const, ref })));

  // Channels (PRD 5.3).
  const channels = [...new Set(raw.channels)].filter((c): c is "email" | "slack" => c === "email" || c === "slack");
  if (channels.length === 0) return { error: "Choose at least one channel: email or Slack." };
  const slackChannels = [...new Set(raw.slackChannelIds)].map((id) => slack?.find((c) => c.id === id));
  if (slackChannels.length && !channels.includes("slack")) return { error: "Tick Slack as a channel to post to Slack channels." };
  if (channels.includes("slack")) {
    if (!slack) return { error: "Slack isn't connected. An admin can connect it under Integrations." };
    if (slackChannels.some((c) => !c)) return { error: "One of the Slack channels no longer exists." };
    const people = targets.some((t) => t.kind === "user" || t.kind === "department");
    if (raw.company && !slackChannels.length)
      return { error: "To send to the whole company on Slack, pick a Slack channel. Everyone isn't messaged one by one." };
    if (!people && !raw.company && !slackChannels.length)
      return { error: "Slack needs a channel, people or a department." };
  }
  if (channels.includes("email") && !targets.length)
    return { error: "Email needs people, a department, the whole company or email addresses." };
  targets.push(...slackChannels.map((c) => ({ kind: "slack_channel" as const, ref: c!.id, label: c!.name })));
  if (targets.length === 0) return { error: "Choose at least one recipient." };

  let sendAt = now;
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
  // Tasks: due is a wall-clock time after the first send, stored as an offset
  // so each occurrence of a repeating task is due the same time after it's sent.
  let dueAfterMinutes: number | null = null;
  if (raw.isTask) {
    const due = zonedToUtc(raw.dueLocal, timeZone);
    if (!due) return { error: "A task needs a due date and time." };
    dueAfterMinutes = Math.round((due.getTime() - sendAt.getTime()) / 60_000);
    if (dueAfterMinutes < 1) return { error: "The due time must be after it's sent." };
    if (dueAfterMinutes > 365 * 24 * 60) return { error: "The due time must be within a year of sending." };
  }
  return {
    input: {
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
    } satisfies ReminderInput,
  };
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

// Every approver gets it in the notification centre; returns the emails of
// those who haven't muted approval emails.
async function approverEmails(tx: Tx, companyId: string, reminderId: string) {
  const rows = await tx
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
  await addNotifications(
    tx,
    rows.map((r) => ({ companyId, userId: r.id, kind: "approval", reminderId, text: "Needs your approval" })),
  );
  const muted = await mutedFor(
    tx,
    rows.map((r) => r.id),
    "approval",
  );
  return rows.filter((r) => !muted.has(`${r.id}:email`)).map((r) => r.email);
}

async function notifyApprovers(emails: string[], title: string, id: string) {
  const url = `${process.env.BETTER_AUTH_URL}/reminders/${id}`;
  for (const to of emails)
    await sendMail({
      to,
      subject: `Approval needed: ${title}`,
      text: `A reminder needs your approval before it can be sent: "${title}".`,
      links: [{ label: "Review it", url }],
    }).catch((e) => console.error("approval email failed", e));
}

async function checked(tx: Tx, companyId: string, actor: Actor, input: ReminderInput) {
  const resolved = await resolveRecipients(tx, companyId, input.targets);
  if (resolved.users.length + resolved.external.length === 0)
    throw new Refused("Nobody would receive this: the chosen departments have no active members.");
  return outOfScope(tx, companyId, actor, input.targets, resolved);
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

// Wakes the worker (LISTEN reminders_due) so "now" means now. Postgres only
// delivers it if this transaction commits. The worker's minute tick catches
// anything a missed notification would have left behind.
async function notifyIfDue(tx: Tx, status: ReminderStatus, sendAt: Date) {
  if (status === "scheduled" && sendAt.getTime() <= Date.now()) await tx.execute(sql`select pg_notify('reminders_due', '')`);
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
export async function createReminder(actor: Actor, companyId: string, input: ReminderInput, files: CheckedFile[] = []) {
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const out = await checked(tx, companyId, actor, input);
      const status: ReminderStatus = out.length ? "pending_approval" : "scheduled";
      const { targets, ...fields } = input;
      let id = "";
      for (let attempt = 0; !id; attempt++) {
        const [row] = await tx
          .insert(reminders)
          .values({ ...fields, companyId, createdBy: actor.id, shortId: shortId(), status })
          .onConflictDoNothing({ target: reminders.shortId })
          .returning({ id: reminders.id });
        if (row) id = row.id;
        else if (attempt > 3) throw new Error("could not allocate a short id");
      }
      await tx.insert(reminderTargets).values(targets.map((t) => ({ ...t, reminderId: id, companyId })));
      await saveAttachments(tx, companyId, id, actor.id, files, []);
      await notifyIfDue(tx, status, input.sendAt);
      return { id, approvers: status === "pending_approval" ? await approverEmails(tx, companyId, id) : [] };
    }),
  );
  if ("error" in result) return result;
  await notifyApprovers(result.approvers, input.title, result.id);
  return { id: result.id };
}

const targetKey = (t: Target) => `${t.kind}:${t.ref}`;

// Creator, or anyone with reminders.edit company-wide.
function mayChange(actor: Actor, createdBy: string) {
  return actor.id === createdBy || can(actor.access, "reminders.edit");
}

export async function updateReminder(
  actor: Actor,
  companyId: string,
  id: string,
  input: ReminderInput,
  files: CheckedFile[] = [],
  removeAttachmentIds: string[] = [],
) {
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const [current] = await tx.select().from(reminders).where(eq(reminders.id, id)).for("update");
      if (!current || !mayChange(actor, current.createdBy)) throw new Refused("Reminder not found.");
      if (!EDITABLE.includes(current.status)) throw new Refused("This reminder can no longer be edited.");

      // The scope check runs as the creator, whoever edits: it's their send.
      const creator = { id: current.createdBy, access: await loadAccess(companyId, current.createdBy) };
      const out = await checked(tx, companyId, creator, input);
      const oldTargets = await tx.select().from(reminderTargets).where(eq(reminderTargets.reminderId, id));
      // An approval covers the recipients it saw. Same or fewer targets keeps it;
      // anything new needs approving again (PRD 5.9).
      const approved = current.status === "scheduled" && current.decidedBy !== null;
      const oldKeys = new Set(oldTargets.map(targetKey));
      const narrowed = input.targets.every((t) => oldKeys.has(targetKey(t)));
      // A paused series stays paused through an edit (unless it now needs approval).
      const status: ReminderStatus =
        out.length && !(approved && narrowed) ? "pending_approval" : current.status === "paused" ? "paused" : "scheduled";

      // The edit form pre-fills the start with the *next* occurrence. If it came
      // back unchanged, keep the original anchor: re-anchoring "monthly on the
      // 31st" at its 30 Apr occurrence would move the series to the 30th.
      if (input.recurrence && current.recurrence && input.anchorLocal === toLocalInput(current.sendAt, current.timeZone)) {
        const next = firstAtOrAfter(input.recurrence, current.anchorLocal, current.timeZone, current.sendAt);
        if (next) input = { ...input, anchorLocal: current.anchorLocal, timeZone: current.timeZone, sendAt: next };
      }
      const { targets, ...fields } = input;
      await tx
        .update(reminders)
        .set({
          ...fields,
          status,
          rejectionReason: null,
          ...(status === "pending_approval" ? { decidedBy: null, decidedAt: null } : {}),
        })
        .where(eq(reminders.id, id));
      await tx.delete(reminderTargets).where(eq(reminderTargets.reminderId, id));
      await tx.insert(reminderTargets).values(targets.map((t) => ({ ...t, reminderId: id, companyId })));
      await saveAttachments(tx, companyId, id, actor.id, files, removeAttachmentIds);
      await notifyIfDue(tx, status, input.sendAt);
      return { approvers: status === "pending_approval" ? await approverEmails(tx, companyId, id) : [] };
    }),
  );
  if ("error" in result) return result.error;
  await notifyApprovers(result.approvers, input.title, id);
  return null;
}

export async function cancelReminder(actor: Actor, companyId: string, id: string) {
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const [current] = await tx.select().from(reminders).where(eq(reminders.id, id)).for("update");
      if (!current || !mayChange(actor, current.createdBy)) throw new Refused("Reminder not found.");
      if (!EDITABLE.includes(current.status)) throw new Refused("This reminder can no longer be cancelled.");
      await tx.update(reminders).set({ status: "cancelled" }).where(eq(reminders.id, id));
      return null;
    }),
  );
  return result && "error" in result ? result.error : null;
}

// The caller has checked reminders.approve.
export async function decideReminder(actor: Actor, companyId: string, id: string, approve: boolean, reason = "") {
  reason = reason.trim();
  if (!approve && !reason) return "Give a reason for rejecting.";
  if (reason.length > 500) return "Reason must be at most 500 characters.";
  const result = await refusals(() =>
    withTenant(companyId, async (tx) => {
      const [current] = await tx.select().from(reminders).where(eq(reminders.id, id)).for("update");
      if (!current) throw new Refused("Reminder not found.");
      if (current.status !== "pending_approval") throw new Refused("This reminder isn't waiting for approval.");
      await tx
        .update(reminders)
        .set({
          status: approve ? "scheduled" : "rejected",
          decidedBy: actor.id,
          decidedAt: new Date(),
          rejectionReason: approve ? null : reason,
        })
        .where(eq(reminders.id, id));
      if (approve) await notifyIfDue(tx, "scheduled", current.sendAt);
      const [creator] = await tx.select({ email: user.email }).from(user).where(eq(user.id, current.createdBy));
      await addNotifications(tx, [
        {
          companyId,
          userId: current.createdBy,
          kind: "decided",
          reminderId: id,
          actorId: actor.id,
          text: approve ? "Approved" : `Rejected: ${reason}`,
        },
      ]);
      const muted = await mutedFor(tx, [current.createdBy], "decided");
      return { title: current.title, creatorEmail: muted.size ? undefined : creator?.email };
    }),
  );
  if ("error" in result) return result.error;
  if (!approve && result.creatorEmail)
    await sendMail({
      to: result.creatorEmail,
      subject: `Not approved: ${result.title}`,
      text: `Your reminder "${result.title}" wasn't approved.\n\nReason: ${reason}\n\nYou can edit it and submit it again.`,
      links: [{ label: "Open the reminder", url: `${process.env.BETTER_AUTH_URL}/reminders/${id}` }],
    }).catch((e) => console.error("rejection email failed", e));
  return null;
}

// --- Reading -----------------------------------------------------------------

// PRD 5.4, the parts that exist so far: creator, view_all, approvers, managers
// of a department the creator is in, and anyone it was delivered to.
// "full" = may see the delivery log; recipients only see the reminder itself.
export async function reminderAccess(
  companyId: string,
  viewer: Actor & { email: string },
  r: { id: string; createdBy: string },
): Promise<"full" | "recipient" | null> {
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
  return got ? "recipient" : null;
}

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
      .where(eq(reminders.id, id));
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
    const label = (t: Target) =>
      t.kind === "company"
        ? "Everyone in the company"
        : t.kind === "department"
          ? `${deptNames.find((d) => d.id === t.ref)?.name ?? "Deleted department"} (department)`
          : t.kind === "user"
            ? (userNames.find((u) => u.id === t.ref)?.name ?? "Removed person")
            : t.kind === "slack_channel"
              ? `#${t.label ?? t.ref} (Slack)`
              : t.ref!;

    // Why it needs approval, recomputed with the creator's own access.
    let outOfScopeList: string[] = [];
    if (r.reminder.status === "pending_approval") {
      const creator = { id: r.reminder.createdBy, access: await loadAccess(companyId, r.reminder.createdBy) };
      outOfScopeList = await outOfScope(tx, companyId, creator, targets, await resolveRecipients(tx, companyId, targets));
    }
    return { ...r.reminder, creatorName: r.creatorName, creatorEmail: r.creatorEmail, targets, targetLabels: targets.map(label), outOfScope: outOfScopeList };
  });
}

export function listReminders(companyId: string, viewer: Actor) {
  return withTenant(companyId, (tx) =>
    tx
      .select({
        id: reminders.id,
        shortId: reminders.shortId,
        title: reminders.title,
        status: reminders.status,
        sendAt: reminders.sendAt,
        updatedAt: reminders.updatedAt,
        recurrence: reminders.recurrence,
        anchorLocal: reminders.anchorLocal,
        timeZone: reminders.timeZone,
        isTask: reminders.isTask,
      })
      .from(reminders)
      .where(can(viewer.access, "reminders.view_all") ? undefined : eq(reminders.createdBy, viewer.id))
      .orderBy(desc(reminders.sendAt))
      .limit(100),
  );
}

export function listPendingApprovals(companyId: string) {
  return withTenant(companyId, (tx) =>
    tx
      .select({ id: reminders.id, title: reminders.title, sendAt: reminders.sendAt, creatorName: user.name })
      .from(reminders)
      .innerJoin(user, eq(user.id, reminders.createdBy))
      .where(eq(reminders.status, "pending_approval"))
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
export const statusLabel = (r: { status: ReminderStatus; recurrence: Rule | null }) =>
  r.recurrence && r.status === "sent" ? "Ended" : STATUS_LABELS[r.status];

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
    const rows = latest
      ? await tx
          .select({
            id: deliveries.id,
            channel: deliveries.channel,
            address: deliveries.address,
            userName: user.name,
            status: deliveries.status,
            sentAt: deliveries.sentAt,
            lastError: deliveries.lastError,
            attempts: deliveries.attempts,
          })
          .from(deliveries)
          .leftJoin(user, eq(user.id, deliveries.userId))
          .where(eq(deliveries.occurrenceId, latest.id))
          .orderBy(deliveries.channel, deliveries.address)
      : [];
    return { latest: latest ?? null, rows, history };
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
      if (!r || !mayChange(actor, r.createdBy)) throw new Refused("Reminder not found.");
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
