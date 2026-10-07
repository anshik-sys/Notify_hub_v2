import { notFound } from "next/navigation";
import { LinkButton, Page } from "@/components/form";
import { Badge, Muted, Table } from "@/components/table";
import { can, COMPANY_ADMIN_ROLE_ID, visibleRoles } from "@/lib/permissions";
import { requireMember } from "@/lib/session";

export default async function Roles() {
  const { companyId, access } = await requireMember();
  if (!can(access, "roles.manage")) notFound();
  const roles = await visibleRoles(companyId);

  return (
    <Page title="Roles" actions={<LinkButton href="/settings/roles/new">New role</LinkButton>}>
      <Table
        columns={["Role", "Type", "Permissions"]}
        rows={roles.map((r) => ({
          key: r.id,
          href: `/settings/roles/${r.id}`,
          cells: [
            r.name,
            r.companyId === null ? <Badge key="t">Built-in</Badge> : <Muted key="t">Custom</Muted>,
            r.id === COMPANY_ADMIN_ROLE_ID ? "All" : r.permissions.length,
          ],
        }))}
      />
    </Page>
  );
}
