import { notFound } from "next/navigation";
import { can, canGrant, MEMBER_ROLE_ID, visibleRoles } from "@/lib/permissions";
import { listDepartments } from "@/lib/departments";
import { requireMember } from "@/lib/session";
import { Button, CheckboxGroup, Field, firstParam, Form, Page } from "@/components/form";
import { inviteUser } from "../actions";

export default async function InviteUser(props: PageProps<"/users/invite">) {
  const { companyId, access } = await requireMember();
  if (!can(access, "users.create")) notFound();
  // Only roles this admin could grant; Member is always given.
  const roles = (await visibleRoles(companyId)).filter((r) => r.id !== MEMBER_ROLE_ID && canGrant(access, r));
  const departments = await listDepartments(companyId);
  const error = firstParam((await props.searchParams).error);

  return (
    <Page title="Invite someone" back={{ href: "/users", label: "People" }} error={error}>
      <Form action={inviteUser}>
        <Field label="Email" name="email" type="email" autoComplete="off" required />
        {roles.length > 0 && (
          <CheckboxGroup legend="Roles (everyone is a Member)" name="roles" options={roles.map((r) => ({ value: r.id, label: r.name }))} />
        )}
        {departments.length > 0 && (
          <CheckboxGroup legend="Departments" name="departments" options={departments.map((d) => ({ value: d.id, label: d.name }))} />
        )}
        <Button>Send invite</Button>
      </Form>
    </Page>
  );
}
