import Link from "next/link";
import { notFound } from "next/navigation";
import { listDepartments } from "@/lib/departments";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { Button, Field, firstParam, Form, FormPage, Hint } from "../form";
import { createDepartmentAction } from "./actions";
import styles from "./page.module.css";

export default async function Departments(props: PageProps<"/departments">) {
  const { companyId, access } = await requireMember();
  if (!can(access, "departments.view")) notFound();
  const departments = await listDepartments(companyId);
  const error = firstParam((await props.searchParams).error);

  return (
    <FormPage title="Departments" error={error}>
      {departments.length > 0 ? (
        <ul className={styles.list}>
          {departments.map((d) => (
            <li key={d.id} className={styles.row}>
              <Link href={`/departments/${d.id}`}>{d.name}</Link>
              <span className={styles.meta}>
                {d.members} {d.members === 1 ? "member" : "members"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Hint>No departments yet.</Hint>
      )}
      {can(access, "departments.create") && (
        <Form action={createDepartmentAction}>
          <Field label="New department" name="name" maxLength={100} required />
          <Button>Create department</Button>
        </Form>
      )}
      <Hint>
        <Link href="/">Back</Link>
      </Hint>
    </FormPage>
  );
}
