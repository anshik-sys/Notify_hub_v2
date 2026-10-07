import { randomBytes } from "node:crypto";
import { aliasedTable, and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { deliveries, departmentMembers, departments, reminders, reminderTargets, roles, user, userRoles, type ReminderStatus } from "@/db/schema";
import { sendMail } from "./mail";
import { resolveRecipients, type Target, type Tx } from "./recipients";
import { type Access, can, COMPANY_ADMIN_ROLE_ID, loadAccess } from "./permissions";
import { zonedToUtc } from "./time";

export type { Target };
export type ReminderInput = {
  title: string;
  description: string;
  links: { label: string; url: string }[];
  senderName: string;
  sendAt: Date;
  targets: Target[];
};
type Actor = { id: string; access: Access };

class Refused extends Error {}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EDITABLE: ReminderStatus[] = ["pending_approval", "rejected", "scheduled"];

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
};

export function validateInput(raw: RawReminder, timeZone: string, defaultSender: string, now = new Date()) {
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
  if (targets.length === 0) return { error: "Choose at least one recipient." };

  let sendAt = now;
  if (raw.when === "later") {
    const at = zonedToUtc(raw.sendAtLocal, timeZone);
    if (!at) return { error: "Pick a date and time to send." };
    if (at.getTime() < now.getTime() - 60_000) return { error: "Pick a time in the future." };
    sendAt = at;
  }
  return { input: { title, description, links, senderName, sendAt, targets } satisfies ReminderInput };
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
  return [...new Set(reasons)];
}

// --- Lifecycle ---------------------------------------------------------------

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
const shortId = () => `R-${[...randomBytes(6)].map((b) => ALPHABET[b % 32]).join("")}`;

async function approverEmails(tx: Tx) {
  const rows = await tx
    .selectDistinct({ email: user.email })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(user, eq(user.id, userRoles.userId))
    .where(
      and(
        isNull(user.deactivatedAt),
        or(eq(roles.id, COMPANY_ADMIN_ROLE_ID), sql`'reminders.approve' = any(${roles.permissions})`),
      ),
    );
  return rows.map((r) => r.email);
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

export async function createReminder(actor: Actor, companyId: string, input: ReminderInput) {
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
      await notifyIfDue(tx, status, input.sendAt);
      return { id, approvers: status === "pending_approval" ? await approverEmails(tx) : [] };
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

export async function updateReminder(actor: Actor, companyId: string, id: string, input: ReminderInput) {
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
      const status: ReminderStatus = out.length && !(approved && narrowed) ? "pending_approval" : "scheduled";

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
      await notifyIfDue(tx, status, input.sendAt);
      return { approvers: status === "pending_approval" ? await approverEmails(tx) : [] };
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
      return { title: current.title, creatorEmail: creator?.email };
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
      .where(and(eq(deliveries.reminderId, r.id), eq(deliveries.email, viewer.email.toLowerCase())))
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

export const STATUS_LABELS: Record<ReminderStatus, string> = {
  pending_approval: "Needs approval",
  rejected: "Not approved",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  cancelled: "Cancelled",
};

export async function deliveryLog(companyId: string, reminderId: string) {
  const rows = await withTenant(companyId, (tx) =>
    tx
      .select({
        id: deliveries.id,
        email: deliveries.email,
        status: deliveries.status,
        sentAt: deliveries.sentAt,
        lastError: deliveries.lastError,
        attempts: deliveries.attempts,
      })
      .from(deliveries)
      .where(eq(deliveries.reminderId, reminderId))
      .orderBy(deliveries.email),
  );
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return { rows, counts: { sent: count("sent"), failed: count("failed"), pending: count("queued") + count("sending") } };
}
