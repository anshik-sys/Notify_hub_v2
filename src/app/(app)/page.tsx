import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Button, Hint, Page, Section } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { auth } from "@/lib/auth";
import { can, visibleRoles } from "@/lib/permissions";
import { listPendingApprovals } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { myOpenTasks } from "@/lib/tasks";
import { formatInZone } from "@/lib/time";
import { getUser } from "@/lib/users";

async function signOut() {
  "use server";
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

// Server-rendered per request, so "now" is the request time.
const isOverdue = (d: Date | null) => Boolean(d && d.getTime() < Date.now());

export default async function Home() {
  const { user, companyId, access } = await requireMember();
  const [me, roles, pending, tasks] = await Promise.all([
    getUser(companyId, user.id),
    visibleRoles(companyId),
    can(access, "reminders.approve") ? listPendingApprovals(companyId) : [],
    myOpenTasks(companyId, user.id),
  ]);
  const roleNames = roles.filter((r) => me?.roleIds.includes(r.id)).map((r) => r.name);

  return (
    <Page title={`Hi, ${user.name.split(" ")[0]}`}>
      {pending.length > 0 && (
        <List>
          <ListRow href="/approvals" title={`Approvals waiting (${pending.length})`} meta="Reminders that need your OK to send" />
        </List>
      )}

      {tasks.length > 0 && (
        <Section title={`Your open tasks (${tasks.length})`}>
          <List>
            {tasks.map((t) => (
              <ListRow
                key={`${t.reminderId}-${t.dueAt?.getTime()}`}
                href={`/reminders/${t.reminderId}`}
                title={t.title}
                badge={isOverdue(t.dueAt) ? "Overdue" : undefined}
                meta={t.dueAt ? `Due ${formatInZone(t.dueAt, t.timeZone)}` : undefined}
              />
            ))}
          </List>
        </Section>
      )}

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

      <Section title="Your roles">
        <Hint>{roleNames.join(", ")}</Hint>
      </Section>

      <Section title="Appearance">
        <ThemeSwitcher />
      </Section>

      <Section title="Account">
        <Hint>Signed in as {user.email}</Hint>
        {can(access, "company.edit") && (
          <List>
            <ListRow href="/settings/company" title="Company settings" meta="Daily task follow-up time" />
          </List>
        )}
        <form action={signOut}>
          <Button variant="secondary">Sign out</Button>
        </form>
      </Section>
    </Page>
  );
}
