import { notFound } from "next/navigation";
import { Button, Field, firstParam, Form, Page, Section } from "@/components/form";
import { Muted, Table } from "@/components/table";
import { listGroups } from "@/lib/groups";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { createGroupAction } from "./actions";

// PRD 4: custom distribution lists. Everyone who can see the directory sees
// every group, so they know who a group reaches before sending to it.
export default async function Groups(props: PageProps<"/groups">) {
  const { companyId, access } = await requireMember();
  if (!can(access, "users.view")) notFound();
  const groups = await listGroups(companyId);
  const sp = await props.searchParams;

  return (
    <Page title="Groups" back={{ href: "/users", label: "Team" }} error={firstParam(sp.error)} notice={firstParam(sp.notice)}>
      <Table
        columns={["Group", "Members", "Created by"]}
        empty="No groups yet."
        rows={groups.map((g) => ({
          key: g.id,
          href: `/groups/${g.id}`,
          cells: [g.name, g.members, <Muted key="c">{g.creatorName ?? "Removed person"}</Muted>],
        }))}
      />
      {can(access, "groups.create") && (
        <Section title="New group">
          <Form action={createGroupAction}>
            <Field label="Name" name="name" maxLength={100} required placeholder="On-call engineers" />
            <Button>Create group</Button>
          </Form>
        </Section>
      )}
    </Page>
  );
}
