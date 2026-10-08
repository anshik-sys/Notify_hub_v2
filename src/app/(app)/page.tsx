import Link from "next/link";
import { Hint, Page, Section } from "@/components/form";
import { List, ListRow } from "@/components/list";
import styles from "./page.module.css";
import { StatCards } from "@/components/stats";
import { listNotifications } from "@/lib/notifications";
import { can } from "@/lib/permissions";
import { listPendingApprovals, mayDecide } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { myOpenTasks } from "@/lib/tasks";
import { formatInZone } from "@/lib/time";
import { getUser } from "@/lib/users";
import { setupStatus } from "@/lib/setup";
import { BarChart } from "@/components/chart";
import { deliveryVolume, parseReportFilters } from "@/lib/reports";
import { dashboardStats, dueByDate, filterUrl, upcoming } from "@/lib/views";

// Server-rendered per request, so "now" is the request time.
const isOverdue = (d: Date | null) => Boolean(d && d.getTime() < Date.now());

const TASKS_SHOWN = 5;

// The last 14 days of deliveries, one group per day (company-wide: shown to
// people who can see reports).
async function sendsChart(companyId: string, tz: string) {
  const f = parseReportFilters({}, tz);
  const from = new Date(Date.parse(`${f.to}T00:00Z`) - 13 * 86_400_000).toISOString().slice(0, 10);
  const d = await deliveryVolume(companyId, tz, { ...f, from, bucket: "day" });
  const byDay = new Map(d.rows.map((r) => [r.bucket, r]));
  return Array.from({ length: 14 }, (_, i) => {
    const day = new Date(Date.parse(`${from}T00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const r = byDay.get(day);
    const label = new Date(`${day}T00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    return { label, values: [r?.email.sent ?? 0, r?.slack.sent ?? 0, (r?.email.failed ?? 0) + (r?.slack.failed ?? 0)] };
  });
}

export default async function Home() {
  const { user, companyId, access, timeZone: tz } = await requireMember();
  const viewer = { id: user.id, access };
  const seesReminders = can(access, "reminders.create") || can(access, "reminders.view_all");
  const [me, pending, tasks, stats, next, activity, setup, chart] = await Promise.all([
    getUser(companyId, user.id),
    can(access, "reminders.approve") ? mayDecide(companyId, viewer).then((d) => (d ? listPendingApprovals(companyId) : [])) : [],
    myOpenTasks(companyId, user.id, TASKS_SHOWN + 1),
    seesReminders ? dashboardStats(companyId, viewer, tz) : null,
    seesReminders ? upcoming(companyId, viewer) : [],
    listNotifications(companyId, user.id).then((n) => n.items.slice(0, 8)),
    can(access, "company.edit") ? setupStatus(companyId, user.id) : null,
    can(access, "reports.view") ? sendsChart(companyId, tz) : null,
  ]);

  return (
    <Page title={`Hi, ${user.name.split(" ")[0]}`}>
      {setup && !setup.complete && !setup.dismissed && (
        <List>
          <ListRow href="/setup" title={`Finish setting up (${setup.done} of 3 done)`} meta="Departments, people and managers" />
        </List>
      )}

      {stats && (
        <StatCards
          items={[
            { label: "Needs approval", value: stats.pending, href: filterUrl({ show: "oversee", status: "pending_approval" }), icon: "approvals", hint: "Waiting for an approver" },
            { label: "Active", value: stats.active, href: filterUrl({ show: "oversee", status: "scheduled", sort: "send_asc" }), icon: "reminders", hint: "Scheduled to send" },
            { label: "Due in 7 days", value: stats.dueSoon, href: filterUrl({ show: "oversee", status: "scheduled", to: dueByDate(tz), sort: "send_asc" }), icon: "calendar", hint: "Sending this week" },
            { label: "Completed", value: stats.completed, href: filterUrl({ show: "oversee", status: "sent" }), icon: "check", hint: "Sent and done" },
            { label: "Failed", value: stats.failed, href: filterUrl({ show: "oversee", failed: true }), tone: "danger", icon: "alert", hint: "Deliveries in 30 days" },
          ]}
        />
      )}

      {chart && (
        <Section title="Sends over the last 14 days">
          <BarChart
            series={[
              { name: "Email", color: 1 },
              { name: "Slack", color: 2 },
              { name: "Failed", color: 3 },
            ]}
            rows={chart}
          />
        </Section>
      )}

      <div className={styles.columns}>
        <div className={styles.column}>
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
        </div>
        <div className={styles.column}>
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
        </div>
      </div>

      <Hint>
        Your groups, roles, appearance and sign out are in <Link href="/settings/profile">Settings</Link>.
      </Hint>
    </Page>
  );
}
