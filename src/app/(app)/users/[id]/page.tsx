import { notFound } from "next/navigation";
import { Button, CheckboxGroup, firstParam, Form, Hint, Page, Section } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { can, canGrant, MEMBER_ROLE_ID, visibleRoles } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { getUser } from "@/lib/users";
import { saveUserRoles, toggleActive } from "../actions";

export default async function UserDetail(props: PageProps<"/users/[id]">) {
  const { user: me, companyId, access } = await requireMember();
  if (!can(access, "users.view")) notFound();
  const { id } = await props.params;
  const person = await getUser(companyId, id); // RLS: only this company's users
  if (!person) notFound();
  const { error, notice } = await props.searchParams;
  const roles = can(access, "users.manage_roles") ? await visibleRoles(companyId) : [];

  return (
    <Page title={person.name} back={{ href: "/users", label: "People" }} error={firstParam(error)} notice={firstParam(notice)}>
      <Hint>
        {person.email}
        {person.deactivatedAt && " · Deactivated"}
      </Hint>

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

      {can(access, "users.activate") && person.id !== me.id && (
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
