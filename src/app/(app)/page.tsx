import Link from "next/link";
import { Hint, Page, Section } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { StatCards } from "@/components/stats";
import { listNotifications } from "@/lib/notifications";
import { can } from "@/lib/permissions";
import { listPendingApprovals } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { myOpenTasks } from "@/lib/tasks";
import { formatInZone } from "@/lib/time";
import { getUser } from "@/lib/users";
import { dashboardStats, dueByDate, filterUrl, upcoming } from "@/lib/views";

// Server-rendered per request, so "now" is the request time.
const isOverdue = (d: Date | null) => Boolean(d && d.getTime() < Date.now());

const TASKS_SHOWN = 5;

export default async function Home() {
  const { user, companyId, access, timeZone: tz } = await requireMember();
  const viewer = { id: user.id, access };
  const seesReminders = can(access, "reminders.create") || can(access, "reminders.view_all");
  const [me, pending, tasks, stats, next, activity] = await Promise.all([
    getUser(companyId, user.id),
    can(access, "reminders.approve") ? listPendingApprovals(companyId) : [],
    myOpenTasks(companyId, user.id, TASKS_SHOWN + 1),
    seesReminders ? dashboardStats(companyId, viewer, tz) : null,
    seesReminders ? upcoming(companyId, viewer) : [],
    listNotifications(companyId, user.id).then((n) => n.items.slice(0, 8)),
  ]);

  return (
    <Page title={`Hi, ${user.name.split(" ")[0]}`}>
      {stats && (
        <StatCards
          items={[
            { label: "Needs approval", value: stats.pending, href: filterUrl({ show: "oversee", status: "pending_approval" }) },
            { label: "Active", value: stats.active, href: filterUrl({ show: "oversee", status: "scheduled", sort: "send_asc" }) },
            { label: "Due in 7 days", value: stats.dueSoon, href: filterUrl({ show: "oversee", status: "scheduled", to: dueByDate(tz), sort: "send_asc" }) },
            { label: "Completed", value: stats.completed, href: filterUrl({ show: "oversee", status: "sent" }) },
            { label: "Failed (30 days)", value: stats.failed, href: filterUrl({ show: "oversee", failed: true }), tone: "danger" },
          ]}
        />
      )}

      {pending.length > 0 && (
        <Section title={`Approvals waiting (${pending.length})`}>
          <List>
            {pending.slice(0, 5).map((p) => (
              <ListRow key={p.id} href={`/reminders/${p.id}`} title={p.title} meta={`From ${p.creatorName}`} />
            ))}
            {pending.length > 5 && <ListRow href="/approvals" title="See all approvals" />}
          </List>
        </Section>
      )}

      {tasks.length > 0 && (
        <Section title="Your open tasks">
          <List>
            {tasks.slice(0, TASKS_SHOWN).map((t) => (
              <ListRow
                key={t.assignmentId}
                href={`/reminders/${t.reminderId}`}
                title={t.title}
                badge={isOverdue(t.dueAt) ? "Overdue" : undefined}
                meta={t.dueAt ? `Due ${formatInZone(t.dueAt, t.timeZone)}` : undefined}
              />
            ))}
            {tasks.length > TASKS_SHOWN && <ListRow href="/tasks" title="See all tasks" />}
          </List>
        </Section>
      )}

      {seesReminders && (
        <Section title="Upcoming">
          {next.length ? (
            <List>
              {next.map((r) => (
                <ListRow
                  key={r.id}
                  href={`/reminders/${r.id}`}
                  title={r.title}
                  badge={r.isTask ? "Task" : undefined}
                  meta={`${formatInZone(r.sendAt, tz)}${r.recurrence ? " · repeats" : ""}`}
                />
              ))}
              <ListRow href="/calendar" title="Open the calendar" />
            </List>
          ) : (
            <Hint>Nothing scheduled.</Hint>
          )}
        </Section>
      )}

      <Section title="Recent activity">
        {activity.length ? (
          <List>
            {activity.map((n) => (
              <ListRow
                key={n.id}
                href={`/notifications/${n.id}`}
                plain
                title={n.text}
                badge={n.readAt ? undefined : "New"}
                meta={`${n.reminderTitle ?? "Deleted reminder"} · ${formatInZone(n.createdAt, tz)}`}
              />
            ))}
          </List>
        ) : (
          <Hint>Nothing yet.</Hint>
        )}
      </Section>

      <Section title="Your departments">
        {me && me.departments.length > 0 ? (
          <List>
            {me.departments.map((d) => (
              <ListRow
                key={d.id}
                href={`/departments/${d.id}`}
                title={d.name}
                badge={d.isManager ? "Manager" : undefined}
                meta={d.isManager ? "You manage this department" : "Member"}
              />
            ))}
          </List>
        ) : (
          <Hint>You’re not in a department yet. An admin or department manager can add you.</Hint>
        )}
      </Section>

      <Hint>
        Your groups, roles, appearance and sign out are in <Link href="/settings/profile">Settings</Link>.
      </Hint>
    </Page>
  );
}
