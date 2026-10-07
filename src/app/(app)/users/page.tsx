import { notFound } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { FilterBar } from "@/components/filters";
import { Button, Field, firstParam, LinkButton, Page, Section } from "@/components/form";
import { Badge, Muted, Table } from "@/components/table";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { listUsers } from "@/lib/users";
import { revokeInvite } from "./actions";
import styles from "./page.module.css";

export default async function Users(props: PageProps<"/users">) {
  const { companyId, access } = await requireMember();
  if (!can(access, "users.view")) notFound();
  const sp = await props.searchParams;
  const q = firstParam(sp.q)?.slice(0, 100) ?? "";
  const { users, pending } = await listUsers(companyId, q);
  const canInvite = can(access, "users.create");
  const showRoles = can(access, "users.manage_roles");

  return (
    <Page
      title="Team"
      error={firstParam(sp.error)}
      notice={firstParam(sp.notice)}
      actions={
        <>
          <LinkButton href="/groups" variant="secondary">
            Groups
          </LinkButton>
          {canInvite && <LinkButton href="/users/invite">Invite someone</LinkButton>}
        </>
      }
    >
      <FilterBar action="/users" clearHref={q ? "/users" : undefined}>
        <Field label="Search" name="q" type="search" placeholder="Name, email or department" defaultValue={q} />
      </FilterBar>
      <Table
        columns={["Name", "Email", "Departments", ...(showRoles ? ["Roles"] : []), "Status"]}
        empty={q ? "Nobody matches that." : undefined}
        rows={users.map((u) => ({
          key: u.id,
          href: `/users/${u.id}`,
          cells: [
            <span key="n" className={styles.person}>
              <Avatar name={u.name} />
              {u.name}
            </span>,
            u.email,
            <Muted key="d">{u.departments.map((d) => (d.isManager ? `${d.name} (manager)` : d.name)).join(", ") || "—"}</Muted>,
            ...(showRoles ? [<Muted key="r">{u.roles.join(", ")}</Muted>] : []),
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
