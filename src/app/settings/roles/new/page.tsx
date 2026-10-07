import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { firstParam, FormPage, Hint } from "../../../form";
import { RoleForm } from "../role-form";

export default async function NewRole(props: PageProps<"/settings/roles/new">) {
  const { access } = await requireMember();
  if (!can(access, "roles.manage")) notFound();
  const error = firstParam((await props.searchParams).error);
  return (
    <FormPage title="New role" error={error}>
      <RoleForm />
      <Hint>
        <Link href="/settings/roles">All roles</Link>
      </Hint>
    </FormPage>
  );
}
