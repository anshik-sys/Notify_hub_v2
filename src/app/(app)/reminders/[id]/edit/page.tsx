import { notFound } from "next/navigation";
import { firstParam, Page } from "@/components/form";
import { can } from "@/lib/permissions";
import { getReminder } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { toLocalInput } from "@/lib/time";
import { isUuid } from "@/lib/validate";
import { recipientChoices } from "../../form-data";
import { ReminderForm } from "../../reminder-form";

export default async function EditReminder(props: PageProps<"/reminders/[id]/edit">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const { user, companyId, company, access } = await requireMember();
  const r = await getReminder(companyId, id);
  // Same rule as updateReminder: creator or reminders.edit, and not yet sent.
  if (!r || !(user.id === r.createdBy || can(access, "reminders.edit"))) notFound();
  if (!["pending_approval", "rejected", "scheduled"].includes(r.status)) notFound();
  const choices = await recipientChoices(companyId, access);
  const error = firstParam((await props.searchParams).error);
  const refs = (kind: string) => r.targets.filter((t) => t.kind === kind).map((t) => t.ref!);

  return (
    <Page title="Edit reminder" back={{ href: `/reminders/${r.id}`, label: r.title }} error={error}>
      <ReminderForm
        {...choices}
        timeZone={company.timeZone}
        defaultSender={`Alerts | ${company.name}`}
        defaults={{
          id: r.id,
          title: r.title,
          description: r.description,
          senderName: r.senderName,
          links: r.links,
          company: r.targets.some((t) => t.kind === "company"),
          departmentIds: refs("department"),
          userIds: refs("user"),
          emails: refs("email").join("\n"),
          when: "later",
          sendAtLocal: toLocalInput(r.sendAt, company.timeZone),
        }}
      />
    </Page>
  );
}
