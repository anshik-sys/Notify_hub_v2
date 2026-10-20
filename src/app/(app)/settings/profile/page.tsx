import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { Button, Checkbox, Field, FileField, firstParam, Form, Hint, Page, Section, SelectField } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { TIME_ZONES } from "@/lib/time";
import { managersOfMyDepartments } from "@/lib/departments";
import { groupsOf } from "@/lib/groups";
import { visibleRoles } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { getUser, photoUrls } from "@/lib/users";
import { hasPassword } from "@/lib/account";
import { changeEmailAction, savePhotoAction, saveProfileAction, signOutAction } from "../account-actions";

// PRD 3.3: your name and time zone; what you belong to (read-only).
export default async function Profile(props: PageProps<"/settings/profile">) {
  const { user, companyId, company } = await requireMember();
  const [me, roles, groups, managers, withPassword, photos] = await Promise.all([
    getUser(companyId, user.id),
    visibleRoles(companyId),
    groupsOf(companyId, user.id),
    managersOfMyDepartments(companyId, user.id),
    hasPassword(user.id),
    photoUrls(companyId),
  ]);
  const photo = photos.get(user.id);
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

      <Section title="Photo">
        <Form action={savePhotoAction}>
          <Avatar name={user.name} photo={photo} size="large" />
          <FileField label={photo ? "Replace your photo" : "Upload a photo"} name="photo" accept="image/png,image/jpeg,image/gif,image/webp" />
          <Hint>PNG, JPEG, GIF or WebP, up to 1 MB. People in your company see it next to your name.</Hint>
          {photo && <Checkbox label="Remove my photo" name="remove" />}
          <Button>Save photo</Button>
        </Form>
      </Section>

      <Section title="Email">
        <Form action={changeEmailAction}>
          <Field label="New email" name="email" type="email" maxLength={254} required autoComplete="email" />
          {withPassword && <Field label="Current password" name="password" type="password" required autoComplete="current-password" />}
          <Hint>Now {user.email}. We’ll send a link to the new address; nothing changes until you click it.</Hint>
          <Button>Change email</Button>
        </Form>
      </Section>

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

      <Section title="Your data">
        <List>
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
