import { notFound } from "next/navigation";
import { Button, Field, firstParam, Form, Page, Section } from "@/components/form";
import { Table } from "@/components/table";
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
      <Table
        columns={["Department", "Members"]}
        empty="No departments yet."
        rows={departments.map((d) => ({ key: d.id, href: `/departments/${d.id}`, cells: [d.name, d.members] }))}
      />
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
