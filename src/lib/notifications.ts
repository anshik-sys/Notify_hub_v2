import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { withTenant } from "@/db";
import { notificationMutes, notifications, reminders } from "@/db/schema";

// The in-app notification centre (PRD 7.5). Rows are written when the event
// happens, by the web app (inside withTenant) or the worker (owner connection),
// so helpers that write take the caller's transaction.
// Preferences only cover NotifyHub's own notifications: reminders and tasks
// arrive the way the sender chose (decided with the user). In-app is always on.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = Pick<PgTransaction<any, any, any>, "select" | "insert">;
export type NotificationKind = "reminder" | "task" | "approval" | "mention" | "comment" | "decided" | "tasks_done" | "failed";
export type NewNotification = typeof notifications.$inferInsert & { kind: NotificationKind };

// The events a person can mute, and on which channels they're sent.
export const MUTABLE = [
  { event: "approval", label: "A reminder needs my approval", channels: ["email"] },
  { event: "decided", label: "My reminder was rejected", channels: ["email"] },
  { event: "mention", label: "Someone mentioned me in a comment", channels: ["email", "slack"] },
] as const;
export type MutableEvent = (typeof MUTABLE)[number]["event"];
const CHANNEL_KEYS = new Set<string>(MUTABLE.flatMap((m) => m.channels.map((c) => `${m.event}:${c}`)));

export async function addNotifications(tx: Tx, rows: NewNotification[]) {
  if (rows.length) await tx.insert(notifications).values(rows).onConflictDoNothing();
}

// "userId:channel" for each person who turned this event off on that channel.
export async function mutedFor(tx: Tx, userIds: string[], event: MutableEvent) {
  if (!userIds.length) return new Set<string>();
  const rows = await tx
    .select({ userId: notificationMutes.userId, channel: notificationMutes.channel })
    .from(notificationMutes)
    .where(and(inArray(notificationMutes.userId, userIds), eq(notificationMutes.event, event)));
  return new Set(rows.map((r) => `${r.userId}:${r.channel}`));
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

export async function getMutes(companyId: string, userId: string) {
  const rows = await withTenant(companyId, (tx) =>
    tx.select().from(notificationMutes).where(eq(notificationMutes.userId, userId)),
  );
  return new Set(rows.map((r) => `${r.event}:${r.channel}`));
}

// `off` holds "event:channel" keys to mute; unknown keys are ignored.
export async function setMutes(companyId: string, userId: string, off: string[]) {
  const keys = [...new Set(off)].filter((k) => CHANNEL_KEYS.has(k));
  await withTenant(companyId, async (tx) => {
    await tx.delete(notificationMutes).where(eq(notificationMutes.userId, userId));
    if (keys.length)
      await tx.insert(notificationMutes).values(
        keys.map((k) => {
          const [event, channel] = k.split(":");
          return { companyId, userId, event, channel };
        }),
      );
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
