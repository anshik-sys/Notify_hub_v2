import { inArray, sql } from "drizzle-orm";
import { user } from "@/db/schema";
import { sendMail } from "@/lib/mail";
import { addNotifications, mutedFor } from "@/lib/notifications";
import { formatInZone } from "@/lib/time";
import { ownerDb } from "./db";

// PRD 5.8: an assignee still not done the company's escalate_after_days past
// due is escalated, once (escalated_at is the claim): their departments'
// managers hear about it in the app and by email, or the task's creator if
// they have no manager. The notification also lets the manager open the task
// (reminderAccess / canViewWhere). Only thresholds crossed in the last 7 days
// count, so turning the setting on doesn't flood managers with old tasks.
// now and onlyCompany are for tests.
export async function escalateOverdue(now = new Date(), onlyCompany?: string, send: typeof sendMail = sendMail) {
  const mails = await ownerDb.transaction(async (tx) => {
    const { rows } = await tx.execute<{
      id: string;
      company_id: string;
      reminder_id: string;
      user_id: string;
      person: string;
      title: string;
      created_by: string;
      due_at: Date;
      days: number;
      time_zone: string;
    }>(sql`
      update task_assignments a set escalated_at = ${now}
        from reminder_occurrences o, reminders r, companies c, "user" u
       where o.id = a.occurrence_id and r.id = a.reminder_id and c.id = a.company_id and u.id = a.user_id
         and (${onlyCompany ?? null}::uuid is null or c.id = ${onlyCompany ?? null}::uuid)
         and c.escalate_after_days is not null and c.suspended_at is null
         and a.done_at is null and a.escalated_at is null and u.deactivated_at is null
         and r.is_task and r.status <> 'cancelled' and o.due_at is not null
         and o.due_at + make_interval(days => c.escalate_after_days) <= ${now}
         and o.due_at + make_interval(days => c.escalate_after_days) > ${now}::timestamptz - interval '7 days'
      returning a.id, a.company_id, a.reminder_id, a.user_id, u.name as person, r.title, r.created_by, o.due_at,
        c.escalate_after_days as days, c.time_zone`);
    const out: Parameters<typeof sendMail>[0][] = [];
    for (const a of rows) {
      // The worker bypasses RLS: department_members is filtered by company.
      const { rows: managers } = await tx.execute<{ id: string }>(sql`
        select distinct mm.user_id as id from department_members m
          join department_members mm on mm.department_id = m.department_id and mm.is_manager and mm.user_id <> m.user_id
          join "user" mu on mu.id = mm.user_id and mu.deactivated_at is null
         where m.company_id = ${a.company_id} and m.user_id = ${a.user_id}`);
      const tell = managers.length ? managers.map((m) => m.id) : a.created_by !== a.user_id ? [a.created_by] : [];
      if (!tell.length) continue;
      const text = `${a.person} hasn't marked it done, ${a.days} day${a.days === 1 ? "" : "s"} after it was due`;
      await addNotifications(
        tx,
        tell.map((userId) => ({ companyId: a.company_id, userId, kind: "escalated" as const, reminderId: a.reminder_id, text, dedupeKey: `esc:${a.id}` })),
      );
      const muted = await mutedFor(tx, tell, "escalated");
      const to = await tx.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, tell));
      for (const p of to.filter((p) => !muted.has(`${p.id}:email`)))
        out.push({
          to: p.email,
          subject: `Overdue: ${a.person} on “${a.title}”`,
          text: `${text}. It was due ${formatInZone(new Date(a.due_at), a.time_zone)} (${a.time_zone}).`,
          links: [{ label: "Open the task", url: `${process.env.BETTER_AUTH_URL}/reminders/${a.reminder_id}` }],
        });
    }
    return out;
  });
  // After commit; a failed email is logged, not retried (the in-app one stays).
  for (const m of mails) await send(m).catch((e) => console.error("escalation email failed", e));
  return mails.length;
}
