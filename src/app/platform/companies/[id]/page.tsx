import { notFound } from "next/navigation";
import { Button, Checkbox, Field, firstParam, Form, Hint, Page, Section, SelectField } from "@/components/form";
import { StatCards } from "@/components/stats";
import { platformCompanies, requirePlatformOwner } from "@/lib/platform";
import { formatInZone } from "@/lib/time";
import { isUuid } from "@/lib/validate";
import { deleteCompanyAction, editCompanyAction, suspendAction } from "../../actions";

const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

export default async function PlatformCompany(props: PageProps<"/platform/companies/[id]">) {
  await requirePlatformOwner();
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const c = (await platformCompanies()).find((x) => x.id === id);
  if (!c) notFound();
  const sp = await props.searchParams;
  const tz = "UTC";
  const hidden = <input type="hidden" name="companyId" value={c.id} />;
  const empty = c.people === 0 && !c.last_activity;

  return (
    <Page title={c.name} back={{ href: "/platform", label: "Companies" }} error={firstParam(sp.error)} notice={firstParam(sp.notice)}>
      <Hint>
        {c.domain} · created {formatInZone(c.created_at, tz)} (UTC)
        {c.suspended_at && ` · suspended ${formatInZone(c.suspended_at, tz)}`} · admins: {c.admins ?? "none yet"}
      </Hint>
      <StatCards
        items={[
          { label: "Active people", value: c.people, href: "#" },
          { label: "Scheduled reminders", value: c.scheduled, href: "#" },
          { label: "Sent (30 days)", value: c.sent_30d, href: "#" },
          { label: "Failed (30 days)", value: c.failed_30d, href: "#", tone: "danger" },
        ]}
      />

      <Section title="Details">
        <Form action={editCompanyAction}>
          {hidden}
          <Field label="Name" name="name" maxLength={100} required defaultValue={c.name} />
          <Field label="Domain" name="domain" required defaultValue={c.domain} />
          <SelectField label="Time zone" name="timeZone" defaultValue={c.time_zone} options={TIME_ZONES} />
          <Button>Save</Button>
        </Form>
      </Section>

      <Section title={c.suspended_at ? "Suspended" : "Suspend"}>
        <Form action={suspendAction}>
          {hidden}
          <input type="hidden" name="suspend" value={c.suspended_at ? "false" : "true"} />
          <Hint>
            {c.suspended_at
              ? "Its people see a suspended page and nothing is sent. Unsuspending resumes everything; reminders that came due meanwhile follow the normal catch-up rule."
              : "Locks its people out and pauses all sending until you unsuspend it."}
          </Hint>
          <Button variant={c.suspended_at ? "primary" : "danger"}>{c.suspended_at ? "Unsuspend" : "Suspend company"}</Button>
        </Form>
      </Section>

      <Section title="Delete">
        <Form action={deleteCompanyAction}>
          {hidden}
          {empty ? (
            <Checkbox label={`Delete ${c.name} permanently`} required />
          ) : (
            <Hint>Only an empty company can be deleted: its people, reminders and departments must be removed first.</Hint>
          )}
          <Button variant="danger" disabled={!empty}>
            Delete company
          </Button>
        </Form>
      </Section>
    </Page>
  );
}
