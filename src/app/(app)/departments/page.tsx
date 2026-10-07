import { notFound } from "next/navigation";
import { Button, Field, firstParam, Form, Hint, Page, Section } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { listDepartments } from "@/lib/departments";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { createDepartmentAction } from "./actions";

export default async function Departments(props: PageProps<"/departments">) {
  const { companyId, access } = await requireMember();
  if (!can(access, "departments.view")) notFound();
  const departments = await listDepartments(companyId);
  const error = firstParam((await props.searchParams).error);

  return (
    <Page title="Departments" error={error}>
      {departments.length > 0 ? (
        <List>
          {departments.map((d) => (
            <ListRow
              key={d.id}
              href={`/departments/${d.id}`}
              title={d.name}
              meta={`${d.members} ${d.members === 1 ? "member" : "members"}`}
            />
          ))}
        </List>
      ) : (
        <Hint>No departments yet.</Hint>
      )}
      {can(access, "departments.create") && (
        <Section title="New department">
          <Form action={createDepartmentAction}>
            <Field label="Name" name="name" maxLength={100} required />
            <Button>Create department</Button>
          </Form>
        </Section>
      )}
    </Page>
  );
}
