import { notFound } from "next/navigation";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { firstParam, Page } from "@/components/form";
import { RoleForm } from "../role-form";

export default async function NewRole(props: PageProps<"/settings/roles/new">) {
  const { access } = await requireMember();
  if (!can(access, "roles.manage")) notFound();
  const error = firstParam((await props.searchParams).error);
  return (
    <Page title="New role" back={{ href: "/settings/roles", label: "Roles" }} error={error}>
      <RoleForm />
    </Page>
  );
}
