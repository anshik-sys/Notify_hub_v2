import { notFound } from "next/navigation";
import { LinkButton, Page } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { can, visibleRoles } from "@/lib/permissions";
import { requireMember } from "@/lib/session";

export default async function Roles() {
  const { companyId, access } = await requireMember();
  if (!can(access, "roles.manage")) notFound();
  const roles = await visibleRoles(companyId);

  return (
    <Page title="Roles">
      <LinkButton href="/settings/roles/new">New role</LinkButton>
      <List>
        {roles.map((r) => (
          <ListRow
            key={r.id}
            href={`/settings/roles/${r.id}`}
            title={r.name}
            badge={r.companyId === null ? "Built-in" : undefined}
            meta={r.companyId === null ? undefined : `${r.permissions.length} permissions`}
          />
        ))}
      </List>
    </Page>
  );
}
