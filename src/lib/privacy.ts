import { desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { session } from "@/db/schema";
import { authDb } from "./auth";

// PRD 11.5: everything NotifyHub holds about one person, as JSON. Tenant data
// through withTenant (RLS), sessions through authDb (device and times only,
// never tokens). Keep in step with erase_person (migration 0028): a new
// table with personal data belongs in both.

type Rows = { rows: Record<string, unknown>[] };

export async function exportPerson(companyId: string, userId: string) {
  const q = (tx: Parameters<Parameters<typeof withTenant>[1]>[0], query: ReturnType<typeof sql>) =>
    tx.execute(query).then((r) => (r as unknown as Rows).rows);
  const data = await withTenant(companyId, async (tx) => ({
    profile: (
      await q(tx, sql`select id, name, email, time_zone, created_at, deactivated_at, two_factor_enabled from "user" where id = ${userId}`)
    )[0],
    roles: await q(tx, sql`select r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = ${userId}`),
    departments: await q(
      tx,
      sql`select d.name, m.is_manager from department_members m join departments d on d.id = m.department_id where m.user_id = ${userId}`,
    ),
    groups: await q(tx, sql`select g.name from group_members m join groups g on g.id = m.group_id where m.user_id = ${userId}`),
    remindersCreated: await q(
      tx,
      sql`select short_id, title, description, status, send_at, recurrence, tags, created_at from reminders where created_by = ${userId} order by created_at`,
    ),
    tasksAssigned: await q(
      tx,
      sql`select r.title, o.due_at, a.done_at from task_assignments a join reminders r on r.id = a.reminder_id
          join reminder_occurrences o on o.id = a.occurrence_id where a.user_id = ${userId} order by o.due_at`,
    ),
    comments: await q(
      tx,
      sql`select r.title as reminder, c.body, c.created_at, c.edited_at, c.deleted_at from comments c join reminders r on r.id = c.reminder_id
          where c.author_id = ${userId} order by c.created_at`,
    ),
    deliveriesToThem: await q(
      tx,
      sql`select r.title as reminder, d.channel, d.status, d.sent_at from deliveries d join reminders r on r.id = d.reminder_id
          where d.user_id = ${userId} order by d.created_at`,
    ),
    attachmentsUploaded: await q(tx, sql`select file_name, content_type, size, created_at from attachments where uploaded_by = ${userId}`),
    notifications: await q(tx, sql`select kind, text, created_at, read_at from notifications where user_id = ${userId} order by created_at`),
    auditAsActor: await q(
      tx,
      sql`select at, action, object_type, object_label from audit_log where actor_id = ${userId} order by at`,
    ),
  }));
  const sessions = await authDb
    .select({ createdAt: session.createdAt, lastActive: session.updatedAt, ipAddress: session.ipAddress, userAgent: session.userAgent })
    .from(session)
    .where(eq(session.userId, userId))
    .orderBy(desc(session.updatedAt));
  return { exportedAt: new Date().toISOString(), ...data, sessions };
}

export const exportResponse = (data: unknown, userId: string) =>
  new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="person-${userId.slice(0, 12)}.json"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
