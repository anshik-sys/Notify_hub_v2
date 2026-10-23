import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { notifications, reminderOccurrences, reminders, taskAssignments, user } from "@/db/schema";
import { planTell, sendTell, type Tell } from "./notifications";
import { recipientLabels } from "./recipients";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

// Task completion lives in task_assignments: one row per (occurrence, internal
// user), whatever channels it went out on. Each occurrence of a repeating task
// gets new rows, so it starts fresh (PRD 5.8).

// Only your own assignment: user_id = you, under RLS. Returns an error or null.
export async function setDone(viewerId: string, companyId: string, assignmentId: string, done: boolean) {
  const updated = await withTenant(companyId, async (tx) => {
    const rows = await tx
      .update(taskAssignments)
      .set({ doneAt: done ? new Date() : null })
      .where(and(eq(taskAssignments.id, assignmentId), eq(taskAssignments.userId, viewerId)))
      .returning({ occurrenceId: taskAssignments.occurrenceId });
    // An undo matters too: a sub-task's task is no longer done (ST4).
    const tell = rows.length ? await notifyIfAllDone(tx, companyId, rows[0].occurrenceId) : null;
    return { rows, tell };
  });
  if (updated.tell) await sendTell(updated.tell);
  return updated.rows.length ? null : "That task isn't yours to mark.";
}

// The creator hears once per occurrence, when the last assignee is done
// (not per person: a 100-person task would bury everything else). Locking the
// occurrence keeps two "last" clicks from both seeing the other still open.
// Returns the email/Slack to send after commit, only the first time (the
// dedupe key makes an undo and redo a no-op). A sub-task's creator hears once
// for the whole task instead (ST7).
export async function notifyIfAllDone(tx: Tx, companyId: string, occurrenceId: string): Promise<Tell | null> {
  const [occ] = await tx
    .select({ reminderId: reminderOccurrences.reminderId, createdBy: reminders.createdBy, title: reminders.title, parentId: reminders.parentId })
    .from(reminderOccurrences)
    .innerJoin(reminders, eq(reminders.id, reminderOccurrences.reminderId))
    .where(eq(reminderOccurrences.id, occurrenceId))
    .for("update", { of: reminderOccurrences });
  if (!occ) return null;
  if (occ.parentId) return syncParent(tx, companyId, occ.parentId);
  const [{ open }] = await tx
    .select({ open: sql<number>`count(*) filter (where ${taskAssignments.doneAt} is null)::int` })
    .from(taskAssignments)
    .where(eq(taskAssignments.occurrenceId, occurrenceId));
  if (open > 0) return null;
  return tellDone(tx, companyId, { ...occ, occurrenceId });
}

async function tellDone(tx: Tx, companyId: string, occ: { occurrenceId: string; reminderId: string; createdBy: string; title: string }) {
  const text = "Everyone has marked it done";
  const fresh = await tx
    .insert(notifications)
    .values({ companyId, userId: occ.createdBy, kind: "tasks_done", reminderId: occ.reminderId, text, dedupeKey: `done:${occ.occurrenceId}` })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (!fresh.length) return null;
  return planTell(tx, companyId, [occ.createdBy], "tasks_done", {
    subject: `Done: ${occ.title}`,
    text: `${text}: "${occ.title}".`,
    link: { label: "Open the task", url: `${process.env.BETTER_AUTH_URL}/reminders/${occ.reminderId}` },
  });
}

// PRD 14.5: a sub-task is done when all its assignees are, or, with nobody in
// the company assigned, when its single "done" is set. In a query on reminders.
const subTaskDone = sql<boolean>`exists (select 1 from reminder_occurrences o where o.reminder_id = "reminders"."id"
  and o.status in ('sending', 'sent') and case when exists (select 1 from task_assignments a where a.occurrence_id = o.id)
    then not exists (select 1 from task_assignments a where a.occurrence_id = o.id and a.done_at is null)
    else o.done_at is not null end)`;

// ST4: a task with sub-tasks is done when all of them are, recorded as its
// (only) occurrence's single "done"; the creator hears once (ST7).
export async function syncParent(tx: Tx, companyId: string, parentId: string): Promise<Tell | null> {
  const [occ] = await tx
    .select({ occurrenceId: reminderOccurrences.id, reminderId: reminders.id, createdBy: reminders.createdBy, title: reminders.title })
    .from(reminderOccurrences)
    .innerJoin(reminders, eq(reminders.id, reminderOccurrences.reminderId))
    .where(eq(reminderOccurrences.reminderId, parentId))
    .for("update", { of: reminderOccurrences });
  if (!occ) return null;
  const [{ all }] = await tx
    .select({ all: sql<boolean>`coalesce(bool_and(${subTaskDone}), false)` })
    .from(reminders)
    .where(and(eq(reminders.parentId, parentId), isNull(reminders.deletedAt)));
  await tx
    .update(reminderOccurrences)
    .set({ doneAt: all ? sql`coalesce(${reminderOccurrences.doneAt}, now())` : null })
    .where(eq(reminderOccurrences.id, occ.occurrenceId));
  return all ? tellDone(tx, companyId, occ) : null;
}

// ST5: a task's sub-tasks in form order, each with its people and whether it's done.
export function subTasks(companyId: string, parentId: string) {
  return withTenant(companyId, (tx) =>
    tx
      .select({
        id: reminders.id,
        title: reminders.title,
        status: reminders.status,
        sendAt: reminders.sendAt,
        dueAfterMinutes: reminders.dueAfterMinutes,
        done: subTaskDone,
        people: recipientLabels,
        targets: sql<{ kind: string; ref: string | null }[]>`(select coalesce(json_agg(json_build_object('kind', t.kind, 'ref', t.ref)), '[]')
          from reminder_targets t where t.reminder_id = "reminders"."id")`,
      })
      .from(reminders)
      .where(and(eq(reminders.parentId, parentId), isNull(reminders.deletedAt)))
      .orderBy(reminders.createdAt, reminders.id),
  );
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

export function myOpenTasks(companyId: string, userId: string, limit = 20) {
  return withTenant(companyId, (tx) =>
    tx
      .select({
        assignmentId: taskAssignments.id,
        reminderId: reminders.id,
        title: reminders.title,
        timeZone: reminders.timeZone,
        dueAt: reminderOccurrences.dueAt,
      })
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
      .limit(limit),
  );
}

// The ones I've finished, most recent first (the My tasks "Done" tab).
export function myDoneTasks(companyId: string, userId: string, limit = 50) {
  return withTenant(companyId, (tx) =>
    tx
      .select({
        assignmentId: taskAssignments.id,
        reminderId: reminders.id,
        title: reminders.title,
        timeZone: reminders.timeZone,
        dueAt: reminderOccurrences.dueAt,
        doneAt: taskAssignments.doneAt,
      })
      .from(taskAssignments)
      .innerJoin(reminders, eq(reminders.id, taskAssignments.reminderId))
      .innerJoin(reminderOccurrences, eq(reminderOccurrences.id, taskAssignments.occurrenceId))
      .where(and(eq(taskAssignments.userId, userId), isNotNull(taskAssignments.doneAt), isNull(reminders.deletedAt)))
      .orderBy(desc(taskAssignments.doneAt))
      .limit(limit),
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
