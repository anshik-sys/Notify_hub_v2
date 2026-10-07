import { notFound } from "next/navigation";
import { firstParam, Page } from "@/components/form";
import { can } from "@/lib/permissions";
import { getReminder } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { toLocalInput } from "@/lib/time";
import { isUuid } from "@/lib/validate";
import { fieldsFromRule } from "@/lib/recurrence";
import { channelChoices } from "@/lib/slack-installations";
import { recipientChoices } from "../../form-data";
import { ReminderForm } from "../../reminder-form";

// Server-rendered per request, so "now" is the request time.
const isPast = (d: Date) => d.getTime() <= Date.now();
const dueFrom = (sendAt: Date, minutes: number) => new Date(Math.max(sendAt.getTime(), Date.now()) + minutes * 60_000);

export default async function EditReminder(props: PageProps<"/reminders/[id]/edit">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const { user, companyId, company, access } = await requireMember();
  const r = await getReminder(companyId, id);
  // Same rule as updateReminder: creator or reminders.edit, and not yet sent.
  if (!r || !(user.id === r.createdBy || can(access, "reminders.edit"))) notFound();
  if (!["pending_approval", "rejected", "scheduled", "paused"].includes(r.status)) notFound();
  const [choices, slackChannels] = await Promise.all([recipientChoices(companyId, user.id, access), channelChoices(companyId)]);
  const error = firstParam((await props.searchParams).error);
  const refs = (kind: string) => r.targets.filter((t) => t.kind === kind).map((t) => t.ref!);

  return (
    <Page title="Edit reminder" back={{ href: `/reminders/${r.id}`, label: r.title }} error={error}>
      <ReminderForm
        {...choices}
        slackChannels={slackChannels}
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
          // A "Now" reminder (or one whose time has passed while it waited for
          // approval) reopens as "Now"; a past "later" time would fail validation.
          when: isPast(r.sendAt) ? "now" : "later",
          sendAtLocal: isPast(r.sendAt) ? "" : toLocalInput(r.sendAt, r.timeZone),
          repeat: fieldsFromRule(r.recurrence, r.anchorLocal),
          isTask: r.isTask,
          channels: r.channels,
          slackChannelIds: refs("slack_channel"),
          // Same gap after the (next) send as before; "now" if that time has passed.
          dueLocal: r.isTask && r.dueAfterMinutes ? toLocalInput(dueFrom(r.sendAt, r.dueAfterMinutes), r.timeZone) : "",
        }}
      />
    </Page>
  );
}
