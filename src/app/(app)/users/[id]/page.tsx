import { notFound } from "next/navigation";
import { Button, Checkbox, CheckboxGroup, Field, firstParam, Form, Hint, Page, Section } from "@/components/form";
import { Muted, Table } from "@/components/table";
import { describeAgent } from "@/lib/account";
import { formatInZone } from "@/lib/time";
import { List, ListRow } from "@/components/list";
import { can, canGrant, MEMBER_ROLE_ID, visibleRoles } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { getUser, personSessions } from "@/lib/users";
import { isUserId } from "@/lib/validate";
import { erasePersonAction, renamePersonAction, resetTwoFactorAction, saveUserRoles, signOutPersonAction, toggleActive } from "../actions";

export default async function UserDetail(props: PageProps<"/users/[id]">) {
  const { user: me, companyId, access, timeZone } = await requireMember();
  if (!can(access, "users.view")) notFound();
  const { id } = await props.params;
  if (!isUserId(id)) notFound();
  const person = await getUser(companyId, id); // RLS: only this company's users
  if (!person) notFound();
  const { error, notice } = await props.searchParams;
  const roles = can(access, "users.manage_roles") ? await visibleRoles(companyId) : [];
  // Edit rights over this person: users.edit and nobody above you.
  const sessions =
    can(access, "users.edit") && !person.erasedAt && person.id !== me.id ? await personSessions({ id: me.id, access }, companyId, person.id) : null;

  return (
    <Page title={person.name} back={{ href: "/users", label: "Team" }} error={firstParam(error)} notice={firstParam(notice)}>
      <Hint>
        {person.email}
        {person.deactivatedAt && " · Deactivated"}
        {` · Two-factor ${person.twoFactorEnabled ? "on" : "off"}`}
      </Hint>

      {sessions && (
        <Form action={renamePersonAction}>
          <input type="hidden" name="userId" value={person.id} />
          <Field label="Name" name="name" maxLength={100} required defaultValue={person.name} />
          <Hint>Only they can change their email: the new address has to be verified.</Hint>
          <Button>Save name</Button>
        </Form>
      )}

      <Section title="Departments">
        {person.departments.length > 0 ? (
          <List>
            {person.departments.map((d) => (
              <ListRow key={d.id} href={`/departments/${d.id}`} title={d.name} badge={d.isManager ? "Manager" : undefined} />
            ))}
          </List>
        ) : (
          <Hint>Not in any department.</Hint>
        )}
      </Section>

      {roles.length > 0 && (
        <Form action={saveUserRoles}>
          <input type="hidden" name="userId" value={person.id} />
          <CheckboxGroup
            legend="Roles"
            name="roles"
            options={roles.map((r) => ({
              value: r.id,
              label: r.name,
              checked: r.id === MEMBER_ROLE_ID || person.roleIds.includes(r.id),
              // Member is the baseline; roles beyond your own permissions are shown but locked.
              disabled: r.id === MEMBER_ROLE_ID || !canGrant(access, r),
            }))}
          />
          <Button>Save roles</Button>
        </Form>
      )}

      {sessions && (
        <Section title="Where they’re signed in">
          {sessions.length ? (
            <>
              <Table
                columns={["Device", "IP", "Signed in", "Last active"]}
                rows={sessions.map((s) => ({
                  key: s.id,
                  cells: [describeAgent(s.userAgent), <Muted key="ip">{s.ipAddress || "—"}</Muted>, formatInZone(s.createdAt, timeZone), formatInZone(s.updatedAt, timeZone)],
                }))}
              />
              <Form action={signOutPersonAction}>
                <input type="hidden" name="userId" value={person.id} />
                <Button variant="secondary">Sign out everywhere</Button>
              </Form>
            </>
          ) : (
            <Hint>Not signed in anywhere.</Hint>
          )}
        </Section>
      )}

      {can(access, "users.edit") && person.twoFactorEnabled && person.id !== me.id && (
        <Form action={resetTwoFactorAction}>
          <input type="hidden" name="userId" value={person.id} />
          <Hint>For a lost phone: turns their two-factor off and signs them out everywhere.</Hint>
          <Button variant="secondary">Reset two-factor</Button>
        </Form>
      )}

      {person.erasedAt && <Hint>This person’s data was erased. Company records show them as “Deleted person”.</Hint>}

      {can(access, "users.edit") && !person.erasedAt && (
        <Hint>
          {/* A plain link: a prefetching <Link> could fetch the download. */}
          <a href={`/users/${person.id}/export`}>Export their data</a> (everything NotifyHub holds about them, as JSON)
        </Hint>
      )}

      {can(access, "users.delete") && person.deactivatedAt && !person.erasedAt && person.id !== me.id && (
        <Section title="Erase permanently">
          <Form action={erasePersonAction}>
            <input type="hidden" name="userId" value={person.id} />
            <Hint>
              Removes their name, email, password, two-factor, sessions and memberships, and the text of their comments. Reminders they
              created stay (scheduled ones keep sending) and show “Deleted person”. Audit entries lose their name and email.
            </Hint>
            <Checkbox label="I understand this can’t be undone" required />
            <Button variant="danger">Erase {person.name}</Button>
          </Form>
        </Section>
      )}

      {can(access, "users.activate") && person.id !== me.id && !person.erasedAt && (
        <Form action={toggleActive}>
          <input type="hidden" name="userId" value={person.id} />
          <input type="hidden" name="active" value={person.deactivatedAt ? "true" : "false"} />
          {person.deactivatedAt ? (
            <Button variant="secondary">Reactivate</Button>
          ) : (
            <Button variant="danger">Deactivate and sign out everywhere</Button>
          )}
        </Form>
      )}
    </Page>
  );
}
