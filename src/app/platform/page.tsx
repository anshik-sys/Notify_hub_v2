import Link from "next/link";
import { Button, Field, firstParam, Form, Hint, Page, Section, SelectField } from "@/components/form";
import { StatCards } from "@/components/stats";
import { Badge, Muted, Table } from "@/components/table";
import { platformAccess, platformCompanies, platformQueue, requirePlatformOwner } from "@/lib/platform";
import { createCompanyAction } from "./actions";

const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];
const age = (s: number | null) => (s === null ? "—" : s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);

// PRD 9.2: every company's usage and the delivery queue's health.
export default async function PlatformHome(props: PageProps<"/platform">) {
  const a = await platformAccess();
  if ("reason" in a && a.reason === "2fa")
    return (
      <Page title="Turn on two-factor first">
        <Hint>
          The platform console needs two-factor authentication on your account. <Link href="/account/security">Set it up</Link>, then come back.
        </Hint>
      </Page>
    );
  await requirePlatformOwner();
  const [companies, q] = await Promise.all([platformCompanies(), platformQueue()]);
  const sp = await props.searchParams;
  const workerOk = q.worker_seconds !== null && q.worker_seconds < 180;

  return (
    <Page title="Companies" error={firstParam(sp.error)} notice={firstParam(sp.notice)}>
      <StatCards
        items={[
          { label: "Queued now", value: q.queued, href: "#queue" },
          { label: "Sending now", value: q.sending, href: "#queue" },
          { label: "Failed (24 h)", value: q.failed_24h, href: "#queue", tone: "danger" },
          { label: "Due, not dispatched", value: q.overdue_reminders, href: "#queue", tone: "danger" },
        ]}
      />
      <p id="queue">
        Oldest queued: {age(q.oldest_queued_seconds)} · Worker last ticked {age(q.worker_seconds)} ago{" "}
        {workerOk ? <Badge tone="success">Running</Badge> : <Badge tone="danger">Not running</Badge>}
      </p>

      <Table
        columns={["Company", "People", "Scheduled", "Sent 24h", "Failed 24h", "Sent 30d", "Admins", ""]}
        empty="No companies yet."
        rows={companies.map((c) => ({
          key: c.id,
          href: `/platform/companies/${c.id}`,
          cells: [
            <span key="n">
              {c.name} <Muted>{c.domain}</Muted>
            </span>,
            c.people,
            c.scheduled,
            c.sent_24h,
            c.failed_24h,
            c.sent_30d,
            <Muted key="a">{c.admins ?? "—"}</Muted>,
            c.suspended_at ? <Badge key="s" tone="danger">Suspended</Badge> : "",
          ],
        }))}
      />

      <Section title="New company">
        <Form action={createCompanyAction}>
          <Field label="Company name" name="name" maxLength={100} required />
          <Field label="Domain" name="domain" placeholder="acme.com" required />
          <SelectField label="Time zone" name="timeZone" defaultValue="UTC" options={TIME_ZONES} />
          <Field label="First admin’s email (at that domain)" name="adminEmail" type="email" required />
          <Hint>The company is created empty and its first admin gets an invite email. You don’t join it.</Hint>
          <Button>Create company</Button>
        </Form>
      </Section>
    </Page>
  );
}
