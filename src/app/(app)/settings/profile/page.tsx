import Link from "next/link";
import { Button, Field, firstParam, Form, Hint, Page, Section, SelectField } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { TIME_ZONES } from "@/lib/account";
import { managersOfMyDepartments } from "@/lib/departments";
import { groupsOf } from "@/lib/groups";
import { visibleRoles } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { getUser } from "@/lib/users";
import { saveProfileAction, signOutAction } from "../account-actions";

// PRD 3.3: your name and time zone; what you belong to (read-only).
export default async function Profile(props: PageProps<"/settings/profile">) {
  const { user, companyId, company } = await requireMember();
  const [me, roles, groups, managers] = await Promise.all([
    getUser(companyId, user.id),
    visibleRoles(companyId),
    groupsOf(companyId, user.id),
    managersOfMyDepartments(companyId, user.id),
  ]);
  const sp = await props.searchParams;

  return (
    <Page title="Profile" error={firstParam(sp.error)} notice={firstParam(sp.notice)}>
      <Form action={saveProfileAction}>
        <Field label="Name" name="name" maxLength={100} required defaultValue={user.name} />
        <SelectField
          label="Your time zone"
          name="timeZone"
          defaultValue={user.timeZone ?? ""}
          options={[{ value: "", label: `Company default (${company.timeZone})` }, ...TIME_ZONES.map((z) => ({ value: z, label: z }))]}
        />
        <Hint>Changes how times are shown to you. Reminders still send at the time they were set for.</Hint>
        <Button>Save</Button>
      </Form>

      <Section title="Your departments">
        {me && me.departments.length > 0 ? (
          <List>
            {me.departments.map((d) => {
              const heads = managers.filter((m) => m.departmentId === d.id).map((m) => m.name);
              return (
                <ListRow
                  key={d.id}
                  href={`/departments/${d.id}`}
                  title={d.name}
                  badge={d.isManager ? "Manager" : undefined}
                  meta={heads.length ? `Managed by ${heads.join(", ")}` : "No manager yet"}
                />
              );
            })}
          </List>
        ) : (
          <Hint>You’re not in a department yet.</Hint>
        )}
      </Section>

      <Section title="Your groups">
        {groups.length ? (
          <List>
            {groups.map((g) => (
              <ListRow key={g.id} href={`/groups/${g.id}`} title={g.name} />
            ))}
          </List>
        ) : (
          <Hint>You’re not in any group.</Hint>
        )}
      </Section>

      <Section title="Your roles">
        <Hint>{roles.filter((r) => me?.roleIds.includes(r.id)).map((r) => r.name).join(", ")}</Hint>
      </Section>

      <Section title="Appearance">
        <ThemeSwitcher />
      </Section>

      <Section title="More">
        <List>
          <ListRow href="/settings/security" title="Security" meta="Password, two-factor, signed-in devices" />
          <ListRow href="/notifications/preferences" title="Notification preferences" />
          <ListRow href="/settings/profile/export" plain title="Download my data" meta="Everything NotifyHub holds about you, as JSON" />
        </List>
      </Section>

      <Section title="Account">
        <Hint>
          Signed in as {user.email}. <Link href="/settings/security">Manage security</Link>
        </Hint>
        <form action={signOutAction}>
          <Button variant="secondary">Sign out</Button>
        </form>
      </Section>
    </Page>
  );
}
