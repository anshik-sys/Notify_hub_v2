import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import webpush from "web-push";
import { notifications, pushSubscriptions, reminders, user } from "@/db/schema";
import { type MutableEvent, mutedFor } from "@/lib/notifications";
import { ownerDb } from "./db";

// PRD 14.7: every new notification-centre row is pushed to each browser its
// person turned push on in (PU7), unless they muted that event for push (PU8).
// Each run claims everything not yet claimed (pushed_at), so two workers never
// both send one; only rows from the last hour are sent (PU11). A failed send
// is released for another try, up to MAX_TRIES (PU12); the browser shows a
// repeat with the same tag in place of the first, so it's never shown twice.
// A browser the push service says is gone is forgotten (PU5).

const MAX_TRIES = 3;
const FRESH_MS = 3_600_000;
const BODY_MAX = 120;

type Send = (sub: webpush.PushSubscription, payload: string) => Promise<unknown>;

let configured = false;
const realSend: Send = (sub, payload) => {
  if (!configured) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT!, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
    configured = true;
  }
  return webpush.sendNotification(sub, payload, { TTL: 3600 });
};

// Which Preferences row a notification belongs to; reminders, tasks, invites
// and the like can't be muted (null).
function eventOf(n: { kind: string; text: string; dedupeKey: string | null }): MutableEvent | null {
  if (n.dedupeKey?.startsWith("held:")) return "held";
  if (n.kind === "decided") return n.text.startsWith("Approved") ? "approved" : "decided";
  const mutable = ["approval", "mention", "comment", "tasks_done", "failed", "escalated", "rsvp"] as const;
  return (mutable as readonly string[]).includes(n.kind) ? (n.kind as MutableEvent) : null;
}

export async function dispatchPush(send: Send = realSend, onlyCompany?: string, now = new Date()) {
  if (send === realSend && !(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT)) return 0;
  const claimed = await ownerDb
    .update(notifications)
    .set({ pushedAt: now })
    .where(and(isNull(notifications.pushedAt), onlyCompany ? eq(notifications.companyId, onlyCompany) : undefined))
    .returning();
  const fresh = claimed.filter((n) => now.getTime() - n.createdAt.getTime() < FRESH_MS);
  if (!fresh.length) return 0;
  const subs = await ownerDb
    .select({ s: pushSubscriptions })
    .from(pushSubscriptions)
    .innerJoin(user, and(eq(user.id, pushSubscriptions.userId), eq(user.companyId, pushSubscriptions.companyId), isNull(user.deactivatedAt)))
    .where(inArray(pushSubscriptions.userId, [...new Set(fresh.map((n) => n.userId))]));
  const reminderIds = [...new Set(fresh.flatMap((n) => (n.reminderId ? [n.reminderId] : [])))];
  const titles = new Map(
    reminderIds.length
      ? (await ownerDb.select({ id: reminders.id, title: reminders.title }).from(reminders).where(inArray(reminders.id, reminderIds))).map((r) => [r.id, r.title])
      : [],
  );
  let sent = 0;
  for (const n of fresh) {
    // The worker bypasses RLS: only this person's browsers in this company (PU14).
    const mine = subs.filter((x) => x.s.userId === n.userId && x.s.companyId === n.companyId).map((x) => x.s);
    if (!mine.length) continue;
    const event = eventOf(n);
    if (event && (await mutedFor(ownerDb, [n.userId], event)).has(`${n.userId}:push`)) continue;
    const url = `${process.env.BETTER_AUTH_URL}${n.reminderId ? `/reminders/${n.reminderId}${n.commentId ? `#comment-${n.commentId}` : ""}` : "/notifications"}`;
    const payload = JSON.stringify({
      title: (n.reminderId && titles.get(n.reminderId)) || "NotifyHub",
      body: n.text.length > BODY_MAX ? `${n.text.slice(0, BODY_MAX - 1)}…` : n.text,
      url,
      tag: n.id,
    });
    let retry = false;
    for (const s of mine) {
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await ownerDb.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
        else {
          console.error("push failed", status ?? e);
          retry = true;
        }
      }
    }
    if (retry && n.pushAttempts + 1 < MAX_TRIES)
      await ownerDb
        .update(notifications)
        .set({ pushedAt: null, pushAttempts: sql`${notifications.pushAttempts} + 1` })
        .where(eq(notifications.id, n.id));
  }
  return sent;
}
