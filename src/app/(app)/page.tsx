import { Banner, Columns, firstParam, Hint, Page, Section } from "@/components/form";
import { RsvpDialog } from "@/components/rsvp-dialog";
import { rsvpTarget } from "@/lib/events";
import { isAnswer, readRsvp } from "@/lib/invite";
import { List, ListRow } from "@/components/list";
import { StatCards } from "@/components/stats";
import { listNotifications } from "@/lib/notifications";
import { can } from "@/lib/permissions";
import { listPendingApprovals, mayDecide } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { myOpenTasks } from "@/lib/tasks";
import { formatInZone } from "@/lib/time";
import { setupStatus } from "@/lib/setup";
import { dashboardStats, dueByDate, filterUrl, upcoming } from "@/lib/views";

// Server-rendered per request, so "now" is the request time.
const isOverdue = (d: Date | null) => Boolean(d && d.getTime() < Date.now());

const TASKS_SHOWN = 5;
const ACTIVITY_SHOWN = 3; // the full list is behind the bell

export default async function Home(props: PageProps<"/">) {
  const { user, companyId, access, timeZone: tz } = await requireMember();
  const sp = await props.searchParams;
  // PRD 14.3: an emailed reply link, for this person, opens its pop-up over the dashboard.
  const rsvp = firstParam(sp.rsvp) ?? "";
  const invite = readRsvp(rsvp)?.userId === user.id ? await rsvpTarget(rsvp) : null;
  const picked = firstParam(sp.a);
  const viewer = { id: user.id, access };
  const seesReminders = can(access, "reminders.create") || can(access, "reminders.view_all");
  const approver = can(access, "reminders.approve") && (await mayDecide(companyId, viewer));
  const [pending, tasks, stats, next, activity, setup] = await Promise.all([
    approver ? listPendingApprovals(companyId) : [],
    myOpenTasks(companyId, user.id, TASKS_SHOWN + 1),
    seesReminders ? dashboardStats(companyId, viewer, tz) : null,
    seesReminders ? upcoming(companyId, viewer) : [],
    listNotifications(companyId, user.id).then((n) => n.items.slice(0, ACTIVITY_SHOWN)),
    can(access, "company.edit") ? setupStatus(companyId, user.id) : null,
  ]);

  const tasksSection = tasks.length > 0 && (
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
  );

  const upcomingSection = seesReminders && (
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
  );

  const approvalsSection = pending.length > 0 && (
    <Section title={`Approvals waiting (${pending.length})`}>
      <List>
        {pending.slice(0, 5).map((p) => (
          <ListRow key={p.id} href={`/reminders/${p.id}`} title={p.title} meta={`From ${p.creatorName}`} />
        ))}
        {pending.length > 5 && <ListRow href="/approvals" title="See all approvals" />}
      </List>
    </Section>
  );

  const activitySection = (
    <Section title="Recent activity">
      {activity.length ? (
        <List>
          {activity.map((n) => (
            <ListRow
              key={n.id}
              href={`/notifications/${n.id}`}
              plain
              title={n.text}
              meta={`${n.reminderTitle ?? "Deleted reminder"} · ${formatInZone(n.createdAt, tz)}`}
            />
          ))}
        </List>
      ) : (
        <Hint>Nothing yet.</Hint>
      )}
    </Section>
  );

  // Two columns: your work on the left (tasks, what's coming), things that
  // need a look on the right (approvals, activity). With no work to show,
  // the right column's content moves left.
  const work = (tasksSection || upcomingSection) && (
    <>
      {tasksSection}
      {upcomingSection}
    </>
  );
  const look = (
    <>
      {approvalsSection}
      {activitySection}
    </>
  );
  return (
    <Page title={`Hi, ${user.name.split(" ")[0]}`} notice={firstParam(sp.notice)} error={invite ? undefined : firstParam(sp.error)}>
      {invite && <RsvpDialog token={rsvp} target={invite} picked={isAnswer(picked) ? picked : null} error={firstParam(sp.error)} closeHref="/" />}
      {setup && !setup.complete && !setup.dismissed && (
        <Banner href="/setup" title="Finish setting up" done={setup.done} total={3} action="Continue" />
      )}

      {stats && (
        <StatCards
          items={[
            // Approvers have the "Approvals waiting" section instead; for
            // everyone else this is where their own held reminders show.
            ...(approver
              ? []
              : [{ label: "Needs approval", value: stats.pending, href: filterUrl({ show: "oversee", status: "pending_approval" }), tone: "warning" as const, icon: "approvals" as const }]),
            { label: "Active", value: stats.active, href: filterUrl({ show: "oversee", status: "scheduled", sort: "send_asc" }), tone: "info", icon: "reminders" },
            { label: "Due in 7 days", value: stats.dueSoon, href: filterUrl({ show: "oversee", status: "scheduled", to: dueByDate(tz), sort: "send_asc" }), icon: "calendar" },
            { label: "Completed", value: stats.completed, href: filterUrl({ show: "oversee", status: "sent" }), tone: "success", icon: "check" },
            { label: "Failed (30 days)", value: stats.failed, href: filterUrl({ show: "oversee", failed: true }), tone: "danger", icon: "alert" },
          ]}
        />
      )}

      {work ? <Columns main={work} side={look} /> : look}
    </Page>
  );
}
