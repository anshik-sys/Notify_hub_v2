import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { reminderOccurrences, reminders, taskAssignments, user } from "@/db/schema";

// Task completion lives in task_assignments: one row per (occurrence, internal
// user), whatever channels it went out on. Each occurrence of a repeating task
// gets new rows, so it starts fresh (PRD 5.8).

// Only your own assignment: user_id = you, under RLS. Returns an error or null.
export async function setDone(viewerId: string, companyId: string, assignmentId: string, done: boolean) {
  const updated = await withTenant(companyId, (tx) =>
    tx
      .update(taskAssignments)
      .set({ doneAt: done ? new Date() : null })
      .where(and(eq(taskAssignments.id, assignmentId), eq(taskAssignments.userId, viewerId)))
      .returning({ id: taskAssignments.id }),
  );
  return updated.length ? null : "That task isn't yours to mark.";
}

// Per-person status for one occurrence (owners' view).
export async function taskProgress(companyId: string, occurrenceId: string) {
  const rows = await withTenant(companyId, (tx) =>
    tx
      .select({
        assignmentId: taskAssignments.id,
        name: user.name,
        email: user.email,
        doneAt: taskAssignments.doneAt,
        followups: taskAssignments.followups,
      })
      .from(taskAssignments)
      .innerJoin(user, eq(user.id, taskAssignments.userId))
      .where(eq(taskAssignments.occurrenceId, occurrenceId))
      .orderBy(user.name),
  );
  return { rows, done: rows.filter((r) => r.doneAt).length, total: rows.length };
}

export function myOpenTasks(companyId: string, userId: string) {
  return withTenant(companyId, (tx) =>
    tx
      .select({ reminderId: reminders.id, title: reminders.title, timeZone: reminders.timeZone, dueAt: reminderOccurrences.dueAt })
      .from(taskAssignments)
      .innerJoin(reminders, eq(reminders.id, taskAssignments.reminderId))
      .innerJoin(reminderOccurrences, eq(reminderOccurrences.id, taskAssignments.occurrenceId))
      .where(
        and(
          eq(taskAssignments.userId, userId),
          isNull(taskAssignments.doneAt),
          sql`${reminders.status} <> 'cancelled'`,
          isNotNull(reminderOccurrences.dueAt),
        ),
      )
      .orderBy(reminderOccurrences.dueAt)
      .limit(20),
  );
}

// The viewer's own latest assignment on a reminder (the recipient's view).
export async function myTaskStatus(companyId: string, userId: string, reminderId: string) {
  const [row] = await withTenant(companyId, (tx) =>
    tx
      .select({ assignmentId: taskAssignments.id, doneAt: taskAssignments.doneAt, dueAt: reminderOccurrences.dueAt })
      .from(taskAssignments)
      .innerJoin(reminderOccurrences, eq(reminderOccurrences.id, taskAssignments.occurrenceId))
      .where(and(eq(taskAssignments.reminderId, reminderId), eq(taskAssignments.userId, userId)))
      .orderBy(desc(reminderOccurrences.occursAt))
      .limit(1),
  );
  return row ?? null;
}
