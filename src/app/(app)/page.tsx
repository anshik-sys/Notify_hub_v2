import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Button, Hint, Page, Section } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { auth } from "@/lib/auth";
import { visibleRoles } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { getUser } from "@/lib/users";

async function signOut() {
  "use server";
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

export default async function Home() {
  const { user, companyId } = await requireMember();
  const [me, roles] = await Promise.all([getUser(companyId, user.id), visibleRoles(companyId)]);
  const roleNames = roles.filter((r) => me?.roleIds.includes(r.id)).map((r) => r.name);

  return (
    <Page title={`Hi, ${user.name.split(" ")[0]}`}>
      <Section title="Your departments">
        {me && me.departments.length > 0 ? (
          <List>
            {me.departments.map((d) => (
              <ListRow
                key={d.id}
                href={`/departments/${d.id}`}
                title={d.name}
                badge={d.isManager ? "Manager" : undefined}
                meta={d.isManager ? "You manage this department" : "Member"}
              />
            ))}
          </List>
        ) : (
          <Hint>You’re not in a department yet. An admin or department manager can add you.</Hint>
        )}
      </Section>

      <Section title="Your roles">
        <Hint>{roleNames.join(", ")}</Hint>
      </Section>

      <Section title="Account">
        <Hint>Signed in as {user.email}</Hint>
        <form action={signOut}>
          <Button variant="secondary">Sign out</Button>
        </form>
      </Section>
    </Page>
  );
}
