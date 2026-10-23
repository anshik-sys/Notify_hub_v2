import { notFound } from "next/navigation";
import { Button, Form, Hint, LinkButton, Page, Section, SelectField, TextArea, firstParam } from "@/components/form";
import { Badge } from "@/components/table";
import { listDepartments } from "@/lib/departments";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { setupStatus } from "@/lib/setup";
import { listUsers } from "@/lib/users";
import { addDepartmentsAction, dismissSetupAction, invitePeopleAction, setManagerAction } from "./actions";

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
  const badge = (done: boolean, optional = false) => (done ? <Badge tone="success">Done</Badge> : optional ? <Badge>Optional</Badge> : null);

  return (
    <Page title={`Set up ${company.name}`} error={firstParam(sp.error)} notice={firstParam(sp.notice)}>
      <Hint>
        {status.complete ? "The essentials are done. " : `${status.done} of 3 essentials done. `}
        Everything here can also be done later from the menu.
      </Hint>

      <Section step={1} title="Create your departments" badge={badge(status.steps.departments)}>
        {departments.length > 0 && <Hint>Departments: {departments.map((d) => d.name).join(", ")}</Hint>}
        <Form action={addDepartmentsAction}>
          <TextArea label="Department names, one per line" name="names" rows={3} placeholder={"Operations\nSales"} />
          <Button variant={status.steps.departments ? "secondary" : "primary"}>Add departments</Button>
        </Form>
      </Section>

      <Section step={2} title="Invite your people" badge={badge(status.steps.people)}>
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
        <LinkButton href="/users/import" variant="secondary">
          Import a CSV instead
        </LinkButton>
      </Section>

      <Section step={3} title="Choose a manager for each department" badge={badge(status.steps.managers)}>
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
        {needManager.length > 0 && <Hint>Invited people can be picked once they’ve accepted.</Hint>}
      </Section>

      <Section step={4} title="Connect Slack" badge={badge(status.steps.slack, true)}>
        {status.steps.slack ? (
          <Hint>Slack is connected.</Hint>
        ) : process.env.SLACK_CLIENT_ID ? (
          <>
            <Hint>Send reminders as Slack messages too.</Hint>
            <LinkButton href="/settings/integrations" variant="secondary">
              Connect Slack
            </LinkButton>
          </>
        ) : (
          <Hint>Slack isn’t available on this server.</Hint>
        )}
      </Section>

      <Section step={5} title="Send your first reminder" badge={badge(status.steps.reminder, true)}>
        <Hint>For a department, a few people or everyone.</Hint>
        <LinkButton href="/reminders/new" variant="secondary">
          Create a reminder
        </LinkButton>
      </Section>

      {!status.dismissed && (
        <form action={dismissSetupAction}>
          <Button variant="secondary">I’m done for now</Button>
        </form>
      )}
    </Page>
  );
}
