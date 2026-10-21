import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { withTenant } from "@/db";
import { notificationMutes, notifications, reminders, slackInstallations, user } from "@/db/schema";
import { decrypt } from "./crypto";
import { sendMail } from "./mail";
import { linkDm } from "./slack";

// The in-app notification centre (PRD 7.5). Rows are written when the event
// happens, by the web app (inside withTenant) or the worker (owner connection),
// so helpers that write take the caller's transaction.
// Preferences only cover NotifyHub's own notifications: reminders and tasks
// arrive the way the sender chose (decided with the user). In-app is always on.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = Pick<PgTransaction<any, any, any>, "select" | "insert">;
export type NotificationKind = "reminder" | "task" | "approval" | "mention" | "comment" | "decided" | "tasks_done" | "failed" | "escalated" | "rsvp";
export type NewNotification = typeof notifications.$inferInsert & { kind: NotificationKind };

// The events a person can mute, and on which channels they're sent.
// PRD 7.5: the events people choose channels for. `off` channels start off,
// so adding one never starts mailing everyone. Choices are stored only where
// they differ from the default (notification_mutes.enabled).
export const MUTABLE = [
  { event: "approval", label: "A reminder needs my approval", channels: ["email", "slack"], off: [] },
  { event: "approved", label: "My reminder was approved", channels: ["email", "slack"], off: ["email", "slack"] },
  { event: "decided", label: "My reminder was rejected", channels: ["email", "slack"], off: [] },
  { event: "mention", label: "Someone mentioned me in a comment", channels: ["email", "slack"], off: [] },
  { event: "comment", label: "Someone commented on my reminder", channels: ["email", "slack"], off: ["email", "slack"] },
  { event: "tasks_done", label: "Everyone finished my task", channels: ["email", "slack"], off: ["email", "slack"] },
  { event: "failed", label: "Some deliveries failed", channels: ["email", "slack"], off: ["slack"] },
  { event: "held", label: "My company reached its daily email limit", channels: ["email"], off: [] },
  { event: "escalated", label: "Someone in my department is late on a task", channels: ["email", "slack"], off: [] },
  { event: "rsvp", label: "A guest answered my event", channels: ["email", "slack"], off: ["email", "slack"] },
] as const satisfies readonly { event: string; label: string; channels: readonly Channel[]; off: readonly Channel[] }[];
type Channel = "email" | "slack";
export type MutableEvent = (typeof MUTABLE)[number]["event"];
const CHANNEL_KEYS = new Set<string>(MUTABLE.flatMap((m) => m.channels.map((c) => `${m.event}:${c}`)));
const startsOn = (event: string, channel: string) => !MUTABLE.find((m) => m.event === event)?.off.some((c) => c === channel);
const channelsOf = (event: MutableEvent): readonly Channel[] => MUTABLE.find((m) => m.event === event)?.channels ?? [];

export async function addNotifications(tx: Tx, rows: NewNotification[]) {
  if (rows.length) await tx.insert(notifications).values(rows).onConflictDoNothing();
}

// "userId:channel" for each person this event is off for on that channel:
// turned off, or never turned on where it starts off.
export async function mutedFor(tx: Tx, userIds: string[], event: MutableEvent) {
  if (!userIds.length) return new Set<string>();
  const rows = await tx
    .select({ userId: notificationMutes.userId, channel: notificationMutes.channel, enabled: notificationMutes.enabled })
    .from(notificationMutes)
    .where(and(inArray(notificationMutes.userId, userIds), eq(notificationMutes.event, event)));
  const chosen = new Map(rows.map((r) => [`${r.userId}:${r.channel}`, r.enabled]));
  return new Set(
    userIds.flatMap((u) => channelsOf(event).filter((c) => !(chosen.get(`${u}:${c}`) ?? startsOn(event, c))).map((c) => `${u}:${c}`)),
  );
}

// --- Email and Slack for these events --------------------------------------------
// Decided inside the event's transaction (planTell), sent after it commits
// (sendTell), so a failed send never undoes the event and a rolled-back event
// sends nothing. Failures are logged, not retried: the in-app row stays.

type Message = { subject: string; text: string; link: { label: string; url: string } };
export type Tell = Message & { emails: string[]; slack: { tokenEnc: string; emails: string[] } | null };

export async function planTell(tx: Tx, companyId: string, userIds: string[], event: MutableEvent, msg: Message): Promise<Tell> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return { ...msg, emails: [], slack: null };
  const muted = await mutedFor(tx, ids, event);
  // The worker bypasses RLS: filter by company explicitly.
  const people = await tx
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(and(inArray(user.id, ids), eq(user.companyId, companyId), isNull(user.deactivatedAt)));
  const on = (c: Channel) => (channelsOf(event).includes(c) ? people.filter((p) => !muted.has(`${p.id}:${c}`)).map((p) => p.email) : []);
  const slackEmails = on("slack");
  const [inst] = slackEmails.length
    ? await tx.select({ tokenEnc: slackInstallations.botTokenEnc }).from(slackInstallations).where(eq(slackInstallations.companyId, companyId))
    : [];
  return { ...msg, emails: on("email"), slack: inst ? { tokenEnc: inst.tokenEnc, emails: slackEmails } : null };
}

export async function sendTell(t: Tell, send: typeof sendMail = sendMail, f?: typeof fetch) {
  for (const to of t.emails)
    await send({ to, subject: t.subject, text: t.text, links: [t.link] }).catch((e) => console.error(`${t.subject}: email failed`, e));
  if (!t.slack) return;
  const token = decrypt(t.slack.tokenEnc);
  for (const email of t.slack.emails) await linkDm(token, email, t.text, t.link, f).catch((e) => console.error(`${t.subject}: Slack DM failed`, e));
}

const PAGE = 50;

// Newest first. `before` pages back by created_at.
export async function listNotifications(companyId: string, userId: string, before?: Date) {
  const rows = await withTenant(companyId, (tx) =>
    tx
      .select({
        id: notifications.id,
        kind: notifications.kind,
        text: notifications.text,
        reminderId: notifications.reminderId,
        commentId: notifications.commentId,
        reminderTitle: reminders.title,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .leftJoin(reminders, eq(reminders.id, notifications.reminderId))
      .where(and(eq(notifications.userId, userId), before ? lt(notifications.createdAt, before) : undefined))
      .orderBy(desc(notifications.createdAt))
      .limit(PAGE + 1),
  );
  return { items: rows.slice(0, PAGE), more: rows.length > PAGE };
}

export async function unreadCount(companyId: string, userId: string) {
  const [{ n }] = await withTenant(companyId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
  );
  return n;
}

export async function markAllRead(companyId: string, userId: string) {
  await withTenant(companyId, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
  );
}

// Opening a reminder reads everything I was told about it.
export async function markReadForReminder(companyId: string, userId: string, reminderId: string) {
  await withTenant(companyId, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), eq(notifications.reminderId, reminderId), isNull(notifications.readAt))),
  );
}

// "event:channel" keys that are off for this person (defaults included).
export async function getMutes(companyId: string, userId: string) {
  const rows = await withTenant(companyId, (tx) =>
    tx.select().from(notificationMutes).where(eq(notificationMutes.userId, userId)),
  );
  const chosen = new Map(rows.map((r) => [`${r.event}:${r.channel}`, r.enabled]));
  return new Set([...CHANNEL_KEYS].filter((k) => !(chosen.get(k) ?? startsOn(...(k.split(":") as [string, string])))));
}

// `off` holds the "event:channel" keys to turn off; every other listed key is
// on. Stores only what differs from the default; unknown keys are ignored.
export async function setMutes(companyId: string, userId: string, off: string[]) {
  const offSet = new Set(off);
  const rows = [...CHANNEL_KEYS].flatMap((k) => {
    const [event, channel] = k.split(":");
    const enabled = !offSet.has(k);
    return enabled === startsOn(event, channel) ? [] : [{ companyId, userId, event, channel, enabled }];
  });
  await withTenant(companyId, async (tx) => {
    await tx.delete(notificationMutes).where(eq(notificationMutes.userId, userId));
    if (rows.length) await tx.insert(notificationMutes).values(rows);
  });
}

// Marks one of my notifications read; returns where it points, or null.
export async function openNotification(companyId: string, userId: string, id: string) {
  const [n] = await withTenant(companyId, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning({ reminderId: notifications.reminderId, commentId: notifications.commentId }),
  );
  if (!n) return null;
  if (!n.reminderId) return "/notifications";
  return `/reminders/${n.reminderId}${n.commentId ? `#comment-${n.commentId}` : ""}`;
}
