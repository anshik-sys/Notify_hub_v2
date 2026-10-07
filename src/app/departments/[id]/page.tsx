import Link from "next/link";
import { notFound } from "next/navigation";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { isUuid } from "@/lib/validate";
import { Button, Checkbox, Field, firstParam, Form, FormPage, Hint, SelectField } from "../../form";
import {
  addMemberAction,
  deleteDepartmentAction,
  removeMemberAction,
  renameDepartmentAction,
  setManagerAction,
} from "../actions";
import styles from "../page.module.css";

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
    <FormPage title={dept.name} error={error}>
      <h2 className={styles.heading}>Members</h2>
      {dept.members.length > 0 ? (
        <ul className={styles.list}>
          {dept.members.map((m) => (
            <li key={m.id} className={styles.row}>
              <div className={styles.who}>
                <span>
                  {m.name} {m.isManager && <span className={styles.badge}>· Manager</span>}
                </span>
                <span className={styles.meta}>{m.email}</span>
              </div>
              <div className={styles.actions}>
                {edit && (
                  <form action={setManagerAction}>
                    <input type="hidden" name="departmentId" value={dept.id} />
                    <input type="hidden" name="userId" value={m.id} />
                    <input type="hidden" name="isManager" value={m.isManager ? "false" : "true"} />
                    <button className={styles.linkButton}>{m.isManager ? "Unmake manager" : "Make manager"}</button>
                  </form>
                )}
                {manageMembers && (
                  <form action={removeMemberAction}>
                    <input type="hidden" name="departmentId" value={dept.id} />
                    <input type="hidden" name="userId" value={m.id} />
                    <button className={`${styles.linkButton} ${styles.danger}`}>Remove</button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Hint>No members yet.</Hint>
      )}

      {manageMembers && dept.candidates.length > 0 && (
        <Form action={addMemberAction}>
          <input type="hidden" name="departmentId" value={dept.id} />
          <SelectField
            label="Add a member"
            name="userId"
            options={dept.candidates.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
          />
          <Button>Add to {dept.name}</Button>
        </Form>
      )}

      {edit && (
        <Form action={renameDepartmentAction}>
          <input type="hidden" name="departmentId" value={dept.id} />
          <Field label="Name" name="name" defaultValue={dept.name} maxLength={100} required />
          <Button>Rename</Button>
        </Form>
      )}

      {can(access, "departments.delete") && (
        <Form action={deleteDepartmentAction}>
          <input type="hidden" name="departmentId" value={dept.id} />
          {/* A required checkbox stands in for a confirm dialog, without client JS. */}
          <Checkbox label="Delete this department and remove all its members" required />
          <Button variant="danger">Delete department</Button>
        </Form>
      )}

      <Hint>
        <Link href="/departments">All departments</Link>
      </Hint>
    </FormPage>
  );
}
