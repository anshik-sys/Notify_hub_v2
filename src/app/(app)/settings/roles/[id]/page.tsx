import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { withTenant } from "@/db";
import { roles } from "@/db/schema";
import { can, COMPANY_ADMIN_ROLE_ID } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { firstParam, Page } from "@/components/form";
import { isUuid } from "@/lib/validate";
import { RoleForm } from "../role-form";

export default async function EditRole(props: PageProps<"/settings/roles/[id]">) {
  const { companyId, access } = await requireMember();
  if (!can(access, "roles.manage")) notFound();
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  // RLS limits this to system roles and this company's own.
  const [role] = await withTenant(companyId, (tx) => tx.select().from(roles).where(eq(roles.id, id)));
  if (!role) notFound();
  const error = firstParam((await props.searchParams).error);

  return (
    <Page title={role.name} back={{ href: "/settings/roles", label: "Roles" }} error={error}>
      <RoleForm
        role={{
          id: role.id,
          name: role.name,
          permissions: role.permissions,
          system: role.companyId === null,
          admin: role.id === COMPANY_ADMIN_ROLE_ID,
        }}
      />
    </Page>
  );
}
