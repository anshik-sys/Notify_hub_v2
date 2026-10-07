import { notFound } from "next/navigation";
import { Button, firstParam, LinkButton, Page, Section } from "@/components/form";
import { Badge, Muted, Table } from "@/components/table";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { listUsers } from "@/lib/users";
import { revokeInvite } from "./actions";

export default async function Users(props: PageProps<"/users">) {
  const { companyId, access } = await requireMember();
  if (!can(access, "users.view")) notFound();
  const { users, pending } = await listUsers(companyId);
  const { error, notice } = await props.searchParams;
  const canInvite = can(access, "users.create");

  return (
    <Page
      title="People"
      error={firstParam(error)}
      notice={firstParam(notice)}
      actions={canInvite && <LinkButton href="/users/invite">Invite someone</LinkButton>}
    >
      <Table
        columns={["Name", "Email", "Roles", "Status"]}
        rows={users.map((u) => ({
          key: u.id,
          href: `/users/${u.id}`,
          cells: [
            u.name,
            u.email,
            <Muted key="r">{u.roles.join(", ")}</Muted>,
            u.deactivatedAt ? (
              <Badge key="s" tone="danger">
                Deactivated
              </Badge>
            ) : (
              <Badge key="s">Active</Badge>
            ),
          ],
        }))}
      />
      {canInvite && pending.length > 0 && (
        <Section title="Pending invites">
          <Table
            columns={["Email", "Expires", ""]}
            rows={pending.map((p) => ({
              key: p.id,
              cells: [
                p.email,
                p.expiresAt.toISOString().slice(0, 10),
                <form key="r" action={revokeInvite}>
                  <input type="hidden" name="id" value={p.id} />
                  <Button variant="secondary" size="small">
                    Revoke
                  </Button>
                </form>,
              ],
            }))}
          />
        </Section>
      )}
    </Page>
  );
}
