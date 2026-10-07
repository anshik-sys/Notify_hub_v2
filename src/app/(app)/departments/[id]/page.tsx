import { notFound } from "next/navigation";
import { Button, Checkbox, Field, firstParam, Form, Hint, Page, Section, SelectField } from "@/components/form";
import { Badge, Muted, Table } from "@/components/table";
import styles from "./page.module.css";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { isUuid } from "@/lib/validate";
import {
  addMemberAction,
  deleteDepartmentAction,
  removeMemberAction,
  renameDepartmentAction,
  setManagerAction,
} from "../actions";

export default async function DepartmentDetail(props: PageProps<"/departments/[id]">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const { companyId, access } = await requireMember();
  if (!can(access, "departments.view", id)) notFound();
  const dept = await getDepartment(companyId, id); // RLS: only this company's
  if (!dept) notFound();
  const error = firstParam((await props.searchParams).error);

  const manageMembers = can(access, "departments.manage_members", id);
  // No department passed: only company-wide (admin) permissions count here.
  const edit = can(access, "departments.edit");

  return (
    <Page title={dept.name} back={{ href: "/departments", label: "Departments" }} error={error}>
      <Section title={`Members (${dept.members.length})`}>
        <Table
          columns={edit || manageMembers ? ["Name", "Email", "Role", ""] : ["Name", "Email", "Role"]}
          empty="No members yet."
          rows={dept.members.map((m) => ({
            key: m.id,
            cells: [
              m.name,
              m.email,
              m.isManager ? <Badge key="b">Manager</Badge> : <Muted key="b">Member</Muted>,
              ...(edit || manageMembers
                ? [
                    <div key="a" className={styles.rowActions}>
                      {edit && (
                        <form action={setManagerAction}>
                          <input type="hidden" name="departmentId" value={dept.id} />
                          <input type="hidden" name="userId" value={m.id} />
                          <input type="hidden" name="isManager" value={m.isManager ? "false" : "true"} />
                          <Button variant="secondary" size="small">
                            {m.isManager ? "Remove as manager" : "Make manager"}
                          </Button>
                        </form>
                      )}
                      {manageMembers && (
                        <form action={removeMemberAction}>
                          <input type="hidden" name="departmentId" value={dept.id} />
                          <input type="hidden" name="userId" value={m.id} />
                          <Button variant="secondary" size="small">
                            Remove
                          </Button>
                        </form>
                      )}
                    </div>,
                  ]
                : []),
            ],
          }))}
        />
      </Section>

      {manageMembers && (
        <Section title="Add a member">
          {dept.candidates.length > 0 ? (
            <Form action={addMemberAction}>
              <input type="hidden" name="departmentId" value={dept.id} />
              <SelectField
                label="Person"
                name="userId"
                options={dept.candidates.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
              />
              <Button>Add to {dept.name}</Button>
            </Form>
          ) : (
            <Hint>Everyone in the company is already in this department. New people join the company by invite first.</Hint>
          )}
        </Section>
      )}

      {edit && (
        <Section title="Rename">
          <Form action={renameDepartmentAction}>
            <input type="hidden" name="departmentId" value={dept.id} />
            <Field label="Name" name="name" defaultValue={dept.name} maxLength={100} required />
            <Button variant="secondary">Save name</Button>
          </Form>
        </Section>
      )}

      {can(access, "departments.delete") && (
        <Section title="Delete">
          <Form action={deleteDepartmentAction}>
            <input type="hidden" name="departmentId" value={dept.id} />
            {/* A required checkbox stands in for a confirm dialog, without client JS. */}
            <Checkbox label="Delete this department and remove all its members" required />
            <Button variant="danger">Delete department</Button>
          </Form>
        </Section>
      )}
    </Page>
  );
}
