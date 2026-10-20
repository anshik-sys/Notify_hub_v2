import { notFound } from "next/navigation";
import { Button, firstParam, Page } from "@/components/form";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { companyBrand, senderDefault } from "@/lib/company";
import { brandFor } from "@/lib/email-render";
import { fieldsFromRule } from "@/lib/recurrence";
import { channelChoices } from "@/lib/slack-installations";
import { toLocalInput, zonedToUtc } from "@/lib/time";
import { QUICK_TASK_DUE_MINUTES } from "@/lib/reminders";
import { recipientChoices } from "../form-data";
import { REMINDER_FORM_ID, ReminderForm } from "../reminder-form";

export default async function NewReminder(props: PageProps<"/reminders/new">) {
  const { user, companyId, company, access, timeZone } = await requireMember();
  if (!can(access, "reminders.create")) notFound();
  const [choices, slackChannels] = await Promise.all([recipientChoices(companyId, user.id, access), channelChoices(companyId)]);
  const sp = await props.searchParams;
  const error = firstParam(sp.error);
  // From the calendar's quick create (Q5): title, time and type carried over.
  // The calendar's time is in the viewer's zone; the form's is the company's.
  const picked = zonedToUtc(firstParam(sp.at) ?? "", timeZone);
  const asTask = firstParam(sp.task) === "1";
  const asEvent = firstParam(sp.event) === "1";
  const local = (d: Date) => toLocalInput(d, company.timeZone);

  return (
    <Page title="New reminder" back={{ href: "/reminders", label: "Reminders" }} error={error} actions={<Button form={REMINDER_FORM_ID}>Create reminder</Button>}>
      <ReminderForm
        brand={brandFor("", companyId, company.name, (await companyBrand(companyId)).logoVersion)}
        {...choices}
        slackChannels={slackChannels}
        timeZone={company.timeZone}
        defaultSender={senderDefault(company)}
        defaults={{
          title: (firstParam(sp.title) ?? "").slice(0, 200),
          description: "",
          senderName: "",
          links: [],
          company: false,
          departmentIds: [],
          groupIds: [],
          userIds: picked ? [user.id] : [],
          emails: "",
          when: picked ? "later" : "now",
          sendAtLocal: picked ? local(picked) : "",
          tags: "",
          shareMine: false,
          shareDepartmentIds: [],
          shareGroupIds: [],
          shareCompany: false,
          repeat: fieldsFromRule(null, ""),
          isTask: asTask,
          dueLocal: picked && asTask ? local(new Date(picked.getTime() + QUICK_TASK_DUE_MINUTES * 60_000)) : "",
          isEvent: asEvent,
          endLocal: picked && asEvent ? local(new Date(picked.getTime() + 3_600_000)) : "",
          channels: ["email"],
          slackChannelIds: [],
        }}
      />
    </Page>
  );
}
