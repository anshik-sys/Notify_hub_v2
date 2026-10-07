import { notFound } from "next/navigation";
import { Button, firstParam, LinkButton, Page, Section } from "@/components/form";
import { List, ListRow } from "@/components/list";
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
    <Page title="People" error={firstParam(error)} notice={firstParam(notice)}>
      {canInvite && (
        <LinkButton href="/users/invite">Invite someone</LinkButton>
      )}
      <List>
        {users.map((u) => (
          <ListRow
            key={u.id}
            href={`/users/${u.id}`}
            title={u.name}
            badge={u.deactivatedAt ? "Deactivated" : undefined}
            meta={`${u.email} · ${u.roles.join(", ")}`}
          />
        ))}
      </List>
      {canInvite && pending.length > 0 && (
        <Section title="Pending invites">
          <List>
            {pending.map((p) => (
              <ListRow key={p.id} title={p.email} meta={`Expires ${p.expiresAt.toISOString().slice(0, 10)}`}>
                <form action={revokeInvite}>
                  <input type="hidden" name="id" value={p.id} />
                  <Button variant="danger" size="small">
                    Revoke invite
                  </Button>
                </form>
              </ListRow>
            ))}
          </List>
        </Section>
      )}
    </Page>
  );
}
