import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, Form, Hint, Page, SelectField, TextArea, firstParam } from "@/components/form";
import { Badge } from "@/components/table";
import { listDepartments } from "@/lib/departments";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { setupStatus } from "@/lib/setup";
import { listUsers } from "@/lib/users";
import { addDepartmentsAction, dismissSetupAction, invitePeopleAction, setManagerAction } from "./actions";
import styles from "./page.module.css";

// PRD 3.1: the guided setup after onboarding. Progress comes from the real
// data (src/lib/setup.ts), so doing a step elsewhere in the app counts too.
export default async function Setup(props: PageProps<"/setup">) {
  const { user, companyId, company, access } = await requireMember();
  if (!can(access, "company.edit")) notFound();
  const [status, departments, people, sp] = await Promise.all([
    setupStatus(companyId, user.id),
    listDepartments(companyId),
    listUsers(companyId).then((r) => r.users.filter((u) => !u.deactivatedAt)),
    props.searchParams,
  ]);
  const needManager = departments.filter((d) =>
    people.every((p) => !p.departments.some((x) => x.name === d.name && x.isManager)),
  );
  const step = (n: number, title: string, done: boolean, optional = false) => (
    <h2 className={styles.step}>
      <span className={styles.num}>{n}</span> {title} {done ? <Badge tone="success">Done</Badge> : optional ? <Badge>Optional</Badge> : null}
    </h2>
  );

  return (
    <Page title={`Set up ${company.name}`} error={firstParam(sp.error)} notice={firstParam(sp.notice)}>
      <Hint>
        {status.complete ? "The essentials are done. " : `${status.done} of 3 essentials done. `}
        Everything here can also be done later from the menu.
      </Hint>

      <section className={styles.card}>
        {step(1, "Create your departments", status.steps.departments)}
        {departments.length > 0 && <Hint>Departments: {departments.map((d) => d.name).join(", ")}</Hint>}
        <Form action={addDepartmentsAction}>
          <TextArea label="Department names, one per line" name="names" rows={3} placeholder={"Operations\nSales"} />
          <Button variant={status.steps.departments ? "secondary" : "primary"}>Add departments</Button>
        </Form>
      </section>

      <section className={styles.card}>
        {step(2, "Invite your people", status.steps.people)}
        <Form action={invitePeopleAction}>
          <TextArea label="Emails, one per line" name="emails" rows={3} placeholder="ana@company.com" />
          {departments.length > 0 && (
            <SelectField
              label="Into department"
              name="departmentId"
              defaultValue=""
              options={[{ value: "", label: "None for now" }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
            />
          )}
          <Button variant={status.steps.people ? "secondary" : "primary"}>Send invites</Button>
        </Form>
        <Hint>
          Many people? <Link href="/users/import">Import a CSV</Link>.
        </Hint>
      </section>

      <section className={styles.card}>
        {step(3, "Choose a manager for each department", status.steps.managers)}
        {!departments.length ? (
          <Hint>Create a department first.</Hint>
        ) : needManager.length === 0 ? (
          <Hint>Every department has a manager.</Hint>
        ) : (
          needManager.map((d) => (
            <Form key={d.id} action={setManagerAction}>
              <input type="hidden" name="departmentId" value={d.id} />
              <SelectField label={`Manager of ${d.name}`} name="userId" options={people.map((p) => ({ value: p.id, label: p.id === user.id ? `${p.name} (you)` : p.name }))} />
              <Button variant="secondary">Make manager</Button>
            </Form>
          ))
        )}
        <Hint>Invited people can be picked once they’ve accepted.</Hint>
      </section>

      <section className={styles.card}>
        {step(4, "Connect Slack", status.steps.slack, true)}
        {status.steps.slack ? (
          <Hint>Slack is connected.</Hint>
        ) : process.env.SLACK_CLIENT_ID ? (
          <Hint>
            <Link href="/settings/integrations">Connect Slack</Link> to send reminders as Slack messages too.
          </Hint>
        ) : (
          <Hint>Slack isn’t available on this server.</Hint>
        )}
      </section>

      <section className={styles.card}>
        {step(5, "Send your first reminder", status.steps.reminder, true)}
        <Hint>
          <Link href="/reminders/new">Create a reminder</Link> for a department, a few people or everyone.
        </Hint>
      </section>

      {!status.dismissed && (
        <form action={dismissSetupAction}>
          <Button variant="secondary">I’m done for now</Button>
        </form>
      )}
    </Page>
  );
}
