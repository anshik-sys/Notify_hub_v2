import { notFound } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { Button, Checkbox, Field, firstParam, Form, Hint, Page, Section } from "@/components/form";
import { Badge, Muted, Table } from "@/components/table";
import { getGroup, mayEditGroup } from "@/lib/groups";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { isUuid } from "@/lib/validate";
import { PeoplePicker } from "../../reminders/people-picker";
import { addGroupMembersAction, deleteGroupAction, removeGroupMemberAction, renameGroupAction } from "../actions";
import styles from "./page.module.css";

export default async function GroupDetail(props: PageProps<"/groups/[id]">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const { user, companyId, access } = await requireMember();
  if (!can(access, "users.view")) notFound();
  const g = await getGroup(companyId, id); // RLS: only this company's
  if (!g) notFound();
  const sp = await props.searchParams;
  const edit = mayEditGroup({ id: user.id, access }, g);
  const hidden = <input type="hidden" name="groupId" value={g.id} />;

  return (
    <Page title={g.name} back={{ href: "/groups", label: "Groups" }} error={firstParam(sp.error)} notice={firstParam(sp.notice)}>
      <p className={styles.meta}>
        Created by {g.creatorName ?? "a removed person"}
        {g.used > 0 && ` · used by ${g.used} upcoming reminder${g.used === 1 ? "" : "s"}`}
      </p>
      <Section title={`Members (${g.members.length})`}>
        <Table
          columns={["Name", "Email", "Departments", ...(edit ? [""] : [])]}
          empty="No members yet."
          rows={g.members.map((m) => ({
            key: m.id,
            cells: [
              <span key="n" className={styles.person}>
                <Avatar name={m.name} />
                {m.name}
                {m.deactivatedAt && <Badge tone="danger">Deactivated</Badge>}
              </span>,
              m.email,
              <Muted key="d">{m.departments.join(", ") || "—"}</Muted>,
              ...(edit
                ? [
                    <form key="r" action={removeGroupMemberAction}>
                      {hidden}
                      <input type="hidden" name="userId" value={m.id} />
                      <Button variant="secondary" size="small">
                        Remove
                      </Button>
                    </form>,
                  ]
                : []),
            ],
          }))}
        />
      </Section>

      {edit && (
        <>
          <Section title="Add people">
            {g.candidates.length > 0 ? (
              <Form action={addGroupMembersAction}>
                {hidden}
                <Hint>Upcoming reminders to this group need approval again if you add someone outside their sender’s departments.</Hint>
                <PeoplePicker people={g.candidates} initial={[]} />
                <Button>Add to {g.name}</Button>
              </Form>
            ) : (
              <Hint>Everyone in the company is already in this group.</Hint>
            )}
          </Section>

          <Section title="Rename">
            <Form action={renameGroupAction}>
              {hidden}
              <Field label="Name" name="name" maxLength={100} required defaultValue={g.name} />
              <Button variant="secondary">Rename</Button>
            </Form>
          </Section>

          <Section title="Delete">
            <Form action={deleteGroupAction}>
              {hidden}
              {g.used > 0 ? (
                <Hint>Remove this group from its upcoming reminders before deleting it.</Hint>
              ) : (
                <Checkbox label={`Delete ${g.name} for everyone`} required />
              )}
              <Button variant="danger" disabled={g.used > 0}>
                Delete group
              </Button>
            </Form>
          </Section>
        </>
      )}
    </Page>
  );
}
