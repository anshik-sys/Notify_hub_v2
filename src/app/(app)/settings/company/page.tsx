import { notFound, redirect } from "next/navigation";
import { Button, Checkbox, CheckboxGroup, errorUrl, Field, firstParam, Form, Hint, Page, RadioGroup, Section, SelectField } from "@/components/form";
import {
  companySettings,
  eligibleApprovers,
  RETENTION_CHOICES,
  senderDefault,
  setApprovers,
  setDefaultSender,
  setFollowUpTime,
  setRequireTwoFactor,
  setRetention,
} from "@/lib/company";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";

// PRD 9.1 company settings. Every action re-checks company.edit.
async function admin() {
  const m = await requireMember();
  if (!can(m.access, "company.edit")) notFound();
  return m;
}
const done = (error: string | null): never => redirect(error ? errorUrl("/settings/company", error) : "/settings/company?notice=Saved.");

async function saveFollowUp(fd: FormData) {
  "use server";
  const { companyId } = await admin();
  done(await setFollowUpTime(companyId, String(fd.get("followUpTime") ?? "")));
}

async function saveSender(fd: FormData) {
  "use server";
  const { companyId } = await admin();
  done(await setDefaultSender(companyId, String(fd.get("sender") ?? "")));
}

async function saveApprovers(fd: FormData) {
  "use server";
  const { companyId } = await admin();
  done(await setApprovers(companyId, fd.get("mode") === "named" ? "named" : "any", fd.getAll("approvers").map(String)));
}

async function saveTwoFactor(fd: FormData) {
  "use server";
  const { user, companyId } = await admin();
  done(await setRequireTwoFactor(companyId, fd.get("require") === "on", Boolean(user.twoFactorEnabled)));
}

async function saveRetention(fd: FormData) {
  "use server";
  const { companyId } = await admin();
  const v = String(fd.get("retention") ?? "");
  done(await setRetention(companyId, v === "" ? null : Number(v)));
}

export default async function CompanySettings(props: PageProps<"/settings/company">) {
  const { companyId, company, access } = await requireMember();
  if (!can(access, "company.edit")) notFound();
  const [settings, eligible] = await Promise.all([companySettings(companyId), eligibleApprovers(companyId)]);
  const { error, notice } = await props.searchParams;

  return (
    <Page title="Company settings" error={firstParam(error)} notice={firstParam(notice)}>
      <Section title="Sender name">
        <Form action={saveSender}>
          <Field label="Default sender name for new reminders" name="sender" maxLength={100} placeholder={`Alerts | ${company.name}`} defaultValue={settings.defaultSenderName ?? ""} />
          <Hint>Emails show “{senderDefault({ name: company.name, defaultSenderName: settings.defaultSenderName })} via NotifyHub” unless a reminder sets its own.</Hint>
          <Button>Save</Button>
        </Form>
      </Section>

      <Section title="Approvals">
        <Form action={saveApprovers}>
          <RadioGroup
            legend="Who approves sends outside the sender’s departments"
            name="mode"
            value={settings.approvalMode}
            options={[
              { value: "any", label: "Anyone with the Approve permission (admins included)" },
              { value: "named", label: "Only the people ticked below" },
            ]}
          />
          <CheckboxGroup
            legend="Named approvers"
            name="approvers"
            options={eligible.map((p) => ({ value: p.id, label: `${p.name} (${p.email})`, checked: settings.approverIds.includes(p.id) }))}
          />
          <Hint>Only people who can approve are listed. If none of the named ones can any more, everyone who can approve is asked instead.</Hint>
          <Button>Save</Button>
        </Form>
      </Section>

      <Section title="Task follow-ups">
        <Form action={saveFollowUp}>
          <Field label={`Daily task follow-up time (${company.timeZone})`} name="followUpTime" type="time" required defaultValue={settings.followUpTime} />
          <Hint>Everyone with an overdue task gets one reminder a day at this time until they mark it done.</Hint>
          <Button>Save</Button>
        </Form>
      </Section>

      <Section title="Security">
        <Form action={saveTwoFactor}>
          <Checkbox label="Require two-factor authentication for everyone" name="require" defaultChecked={company.requireTwoFactor} />
          <Hint>People without it are sent to set it up before they can use anything else. People who sign in with Google set it up too.</Hint>
          <Button>Save</Button>
        </Form>
      </Section>

      <Section title="Data retention">
        <Form action={saveRetention}>
          <SelectField
            label="Delete finished history after"
            name="retention"
            defaultValue={settings.retentionDays === null ? "" : String(settings.retentionDays)}
            options={[{ value: "", label: "Keep forever" }, ...RETENTION_CHOICES.map((d) => ({ value: String(d), label: `${d} days` }))]}
          />
          <Hint>
            Each night, reminders that are finished (sent, ended, cancelled or rejected) and untouched for this long are deleted with their
            deliveries, comments and files, as are older notifications and audit-log entries. Upcoming and active reminders are never deleted.
            This can’t be undone.
          </Hint>
          <Button>Save</Button>
        </Form>
      </Section>
    </Page>
  );
}
