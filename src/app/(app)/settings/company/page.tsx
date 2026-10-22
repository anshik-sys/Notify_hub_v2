import { notFound, redirect } from "next/navigation";
import { Button, Checkbox, CheckboxGroup, errorUrl, Field, FileField, firstParam, Form, Hint, LinkButton, Page, RadioGroup, Section, SelectField } from "@/components/form";
import {
  companyBrand,
  companySettings,
  eligibleApprovers,
  LOGO_MAX_BYTES,
  removeLogo,
  setLogo,
  setProfile,
  RETENTION_CHOICES,
  senderDefault,
  setApprovers,
  setContact,
  setDefaultSender,
  setEscalateAfterDays,
  setFollowUpTime,
  setRequireTwoFactor,
  setRetention,
} from "@/lib/company";
import { setGoogleCalendarEnabled } from "@/lib/google-calendar";
import { can } from "@/lib/permissions";
import { limits } from "@/lib/rate-limit";
import { requireMember } from "@/lib/session";
import { TIME_ZONES } from "@/lib/time";

// PRD 9.1 company settings. Every action re-checks company.edit.
async function admin() {
  const m = await requireMember();
  if (!can(m.access, "company.edit")) notFound();
  return m;
}
const done = (error: string | null): never => redirect(error ? errorUrl("/settings/company", error) : "/settings/company?notice=Saved.");

async function saveProfile(fd: FormData) {
  "use server";
  const { companyId } = await admin();
  done(await setProfile(companyId, String(fd.get("name") ?? ""), String(fd.get("timeZone") ?? "")));
}

async function saveLogo(fd: FormData) {
  "use server";
  const { user, companyId } = await admin();
  if (fd.get("remove") === "on") return done((await removeLogo(companyId), null));
  const file = fd.get("logo");
  if (!(file instanceof File) || file.size === 0) done("Choose an image to upload.");
  const limited = await limits([[`upload:user:${user.id}`, 30, 3600]]);
  if (limited) done(limited);
  const f = file as File;
  done(await setLogo(companyId, f.name, new Uint8Array(await f.arrayBuffer())));
}

async function saveContact(fd: FormData) {
  "use server";
  const { companyId } = await admin();
  done(await setContact(companyId, String(fd.get("contactEmail") ?? ""), String(fd.get("contactPhone") ?? "")));
}

async function saveFollowUp(fd: FormData) {
  "use server";
  const { companyId } = await admin();
  done((await setFollowUpTime(companyId, String(fd.get("followUpTime") ?? ""))) ?? (await setEscalateAfterDays(companyId, String(fd.get("escalateAfterDays") ?? ""))));
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

// Section 13 (GC7): allow or block connecting Google Calendar.
async function saveGoogle(fd: FormData) {
  "use server";
  const { companyId } = await admin();
  await setGoogleCalendarEnabled(companyId, fd.get("google") === "on");
  done(null);
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
  const [settings, eligible, brand] = await Promise.all([companySettings(companyId), eligibleApprovers(companyId), companyBrand(companyId)]);
  const { error, notice } = await props.searchParams;

  return (
    <Page
      title="Company settings"
      error={firstParam(error)}
      notice={firstParam(notice)}
      actions={
        <LinkButton href="/setup" variant="secondary">
          Setup checklist
        </LinkButton>
      }
    >
      <Section title="Profile">
        <Form action={saveProfile}>
          <Field label="Company name" name="name" maxLength={100} required defaultValue={company.name} />
          <SelectField label="Time zone" name="timeZone" defaultValue={company.timeZone} options={TIME_ZONES} />
          <Hint>
            New reminders use this time zone, and so do the task follow-up and digest times. The domain ({settings.domain}) can only be changed by the
            NotifyHub team.
          </Hint>
          <Button>Save</Button>
        </Form>
      </Section>

      <Section title="Logo">
        <Form action={saveLogo}>
          {brand.logoVersion && (
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element -- a small same-origin image; next/image adds nothing here */}
              <img src={`/api/logo/${companyId}?v=${brand.logoVersion}`} alt={`${company.name} logo`} height={48} />
            </div>
          )}
          <FileField label={brand.logoVersion ? "Replace the logo" : "Upload a logo"} name="logo" accept="image/png,image/jpeg,image/gif,image/webp" />
          {brand.logoVersion && <Checkbox label="Remove the logo" name="remove" />}
          <Hint>PNG, JPEG, GIF or WebP, up to {LOGO_MAX_BYTES / 1024} KB. Shown at the top of your company’s reminder emails.</Hint>
          <Button>Save</Button>
        </Form>
      </Section>

      <Section title="Contact">
        <Form action={saveContact}>
          <Field label="Contact email" name="contactEmail" type="email" autoComplete="email" maxLength={254} defaultValue={settings.contactEmail ?? ""} />
          <Field label="Contact phone" name="contactPhone" type="tel" autoComplete="tel" maxLength={30} defaultValue={settings.contactPhone ?? ""} />
          <Hint>Who NotifyHub should get in touch with about your account. Both optional.</Hint>
          <Button>Save</Button>
        </Form>
      </Section>

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
          <Field
            label="Tell their managers after this many days overdue"
            name="escalateAfterDays"
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            defaultValue={settings.escalateAfterDays ?? ""}
          />
          <Hint>Once per person and task, to the managers of their departments (or the task’s creator if they have none). Leave blank to turn it off.</Hint>
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

      <Section title="Google Calendar">
        <Form action={saveGoogle}>
          <Checkbox label="Let people connect their Google Calendar" name="google" defaultChecked={settings.googleCalendarEnabled} />
          <Hint>
            Each person who connects gets a &ldquo;NotifyHub&rdquo; calendar in their Google account with their reminders, tasks and events. Turning this off removes those
            calendars within a minute.
          </Hint>
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
