import { notFound } from "next/navigation";
import { firstParam, Page } from "@/components/form";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { recipientChoices } from "../form-data";
import { ReminderForm } from "../reminder-form";

export default async function NewReminder(props: PageProps<"/reminders/new">) {
  const { user, companyId, company, access } = await requireMember();
  if (!can(access, "reminders.create")) notFound();
  const choices = await recipientChoices(companyId, user.id, access);
  const error = firstParam((await props.searchParams).error);

  return (
    <Page title="New reminder" back={{ href: "/reminders", label: "Reminders" }} error={error}>
      <ReminderForm
        {...choices}
        timeZone={company.timeZone}
        defaultSender={`Alerts | ${company.name}`}
        defaults={{
          title: "",
          description: "",
          senderName: "",
          links: [],
          company: false,
          departmentIds: [],
          userIds: [],
          emails: "",
          when: "now",
          sendAtLocal: "",
        }}
      />
    </Page>
  );
}
