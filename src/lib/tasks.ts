import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { deliveries, reminderOccurrences, reminders, user } from "@/db/schema";

// Task completion lives on the assignee's delivery row: one per person per
// occurrence, so each occurrence of a repeating task starts fresh (PRD 5.8).

// Only your own delivery: user_id = you, under RLS. Returns an error or null.
export async function setDone(viewerId: string, companyId: string, deliveryId: string, done: boolean) {
  const updated = await withTenant(companyId, (tx) =>
    tx
      .update(deliveries)
      .set({ doneAt: done ? new Date() : null })
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.userId, viewerId), eq(deliveries.status, "sent")))
      .returning({ id: deliveries.id }),
  );
  return updated.length ? null : "That task isn't yours to mark.";
}

// Per-person status for one occurrence (owners' view).
export async function taskProgress(companyId: string, occurrenceId: string) {
  const rows = await withTenant(companyId, (tx) =>
    tx
      .select({
        deliveryId: deliveries.id,
        name: user.name,
        email: deliveries.email,
        doneAt: deliveries.doneAt,
        followups: deliveries.followups,
      })
      .from(deliveries)
      .innerJoin(user, eq(user.id, deliveries.userId)) // assignees = internal recipients
      .where(eq(deliveries.occurrenceId, occurrenceId))
      .orderBy(user.name),
  );
  return { rows, done: rows.filter((r) => r.doneAt).length, total: rows.length };
}

const openTask = (userId: string) =>
  and(eq(deliveries.userId, userId), eq(deliveries.status, "sent"), isNull(deliveries.doneAt), eq(reminders.isTask, true));

export function myOpenTasks(companyId: string, userId: string) {
  return withTenant(companyId, (tx) =>
    tx
      .select({ reminderId: reminders.id, title: reminders.title, timeZone: reminders.timeZone, dueAt: reminderOccurrences.dueAt })
      .from(deliveries)
      .innerJoin(reminders, eq(reminders.id, deliveries.reminderId))
      .innerJoin(reminderOccurrences, eq(reminderOccurrences.id, deliveries.occurrenceId))
      .where(and(openTask(userId), sql`${reminders.status} <> 'cancelled'`, isNotNull(reminderOccurrences.dueAt)))
      .orderBy(reminderOccurrences.dueAt)
      .limit(20),
  );
}

// The viewer's own latest assignment on a reminder (the recipient's view).
export async function myTaskStatus(companyId: string, userId: string, reminderId: string) {
  const [row] = await withTenant(companyId, (tx) =>
    tx
      .select({ deliveryId: deliveries.id, doneAt: deliveries.doneAt, dueAt: reminderOccurrences.dueAt })
      .from(deliveries)
      .innerJoin(reminderOccurrences, eq(reminderOccurrences.id, deliveries.occurrenceId))
      .where(and(eq(deliveries.reminderId, reminderId), eq(deliveries.userId, userId), eq(deliveries.status, "sent")))
      .orderBy(desc(reminderOccurrences.occursAt))
      .limit(1),
  );
  return row ?? null;
}
