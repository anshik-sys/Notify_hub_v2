import { notFound, redirect } from "next/navigation";
import { Button, firstParam, Page } from "@/components/form";
import { coverUrl, getReminder, listAttachments, mayChange } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { companyBrand, senderDefault } from "@/lib/company";
import { brandFor } from "@/lib/email-render";
import { formatInZone, toLocalInput } from "@/lib/time";
import { isWaiting, subTasks } from "@/lib/tasks";
import { mayRemoveFile } from "@/lib/attachments";
import { chainChoices } from "@/lib/views";
import { isUuid } from "@/lib/validate";
import { fieldsFromRule, firstAtOrAfter } from "@/lib/recurrence";
import { channelChoices } from "@/lib/slack-installations";
import { recipientChoices } from "../../form-data";
import { REMINDER_FORM_ID, ReminderForm } from "../../reminder-form";

// Server-rendered per request, so "now" is the request time.
const isPast = (d: Date) => d.getTime() <= Date.now();
const dueFrom = (sendAt: Date, minutes: number) => new Date(Math.max(sendAt.getTime(), Date.now()) + minutes * 60_000);

export default async function EditReminder(props: PageProps<"/reminders/[id]/edit">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const { user, companyId, company, access } = await requireMember();
  const r = await getReminder(companyId, id);
  // Same rule as updateReminder, and not yet sent.
  if (!r || !(await mayChange(companyId, { id: user.id, access }, r.createdBy))) notFound();
  if (!["pending_approval", "rejected", "scheduled", "paused"].includes(r.status)) notFound();
  // A sub-task is edited with its task (PRD 14.5).
  if (r.parentId) redirect(`/reminders/${r.parentId}/edit`);
  const [choices, slackChannels, files, cover, subs, chainTasks] = await Promise.all([
    recipientChoices(companyId, user.id, access),
    channelChoices(companyId),
    listAttachments(companyId, r.id),
    r.isTask ? coverUrl(companyId, r.id) : null,
    r.isTask ? subTasks(companyId, r.id) : [],
    chainChoices(companyId, { id: user.id, access }, r.id),
  ]);
  // Waiting for a task (PRD 14.5): due a whole number of days, or else hours, after it starts.
  const waiting = isWaiting(r) && r.afterId;
  const dueDays = r.dueAfterMinutes && r.dueAfterMinutes % 1440 === 0;
  const subCovers = await Promise.all(subs.map((x) => coverUrl(companyId, x.id)));
  const keys = (ts: { kind: string; ref: string | null }[]) => ts.map((t) => `${t.kind}:${t.ref}`).sort().join();
  const sp = await props.searchParams;
  const error = firstParam(sp.error);
  // From the calendar's "Edit → This one": that upcoming date of the series.
  const occursRaw = new Date(firstParam(sp.occurs) ?? "");
  const occurs =
    r.recurrence && r.status === "scheduled" && occursRaw >= r.sendAt && firstAtOrAfter(r.recurrence, r.anchorLocal, r.timeZone, occursRaw)?.getTime() === occursRaw.getTime()
      ? occursRaw
      : null;
  const refs = (kind: string) => r.targets.filter((t) => t.kind === kind).map((t) => t.ref!);

  return (
    <Page title={`Edit ${r.isEvent ? "event" : r.isTask ? "task" : "reminder"}`} back={{ href: `/reminders/${r.id}`, label: r.title }} error={error} actions={<Button form={REMINDER_FORM_ID}>Save</Button>}>
      <ReminderForm
        brand={brandFor("", companyId, company.name, (await companyBrand(companyId)).logoVersion)}
        {...choices}
        slackChannels={slackChannels}
        attachments={files.map((f) => ({ ...f, removable: mayRemoveFile(f, user.id) }))}
        chainTasks={chainTasks}
        cover={cover}
        timeZone={company.timeZone}
        defaultSender={senderDefault(company)}
        nextLabel={r.recurrence && r.status === "scheduled" ? formatInZone(occurs ?? r.sendAt, r.timeZone) : undefined}
        occursAt={occurs?.toISOString()}
        defaults={{
          id: r.id,
          title: r.title,
          description: r.description,
          senderName: r.senderName,
          links: r.links,
          company: r.targets.some((t) => t.kind === "company"),
          departmentIds: refs("department"),
          groupIds: refs("group"),
          userIds: refs("user"),
          emails: refs("email").join("\n"),
          // A "Now" reminder (or one whose time has passed while it waited for
          // approval) reopens as "Now"; a past "later" time would fail validation.
          when: waiting ? "after" : isPast(r.sendAt) ? "now" : "later",
          sendAtLocal: occurs ? toLocalInput(occurs, r.timeZone) : isPast(r.sendAt) || waiting ? "" : toLocalInput(r.sendAt, r.timeZone),
          afterId: r.afterId ?? undefined,
          dueIn: waiting && r.dueAfterMinutes ? String(r.dueAfterMinutes / (dueDays ? 1440 : 60)) : undefined,
          dueUnit: dueDays ? "days" : "hours",
          tags: r.tags.join(", "),
          // Saved shares are explicit department ids ("my departments" was expanded at save).
          shareMine: false,
          shareDepartmentIds: r.shares.filter((x) => x.kind === "department").map((x) => x.ref!),
          shareGroupIds: r.shares.filter((x) => x.kind === "group").map((x) => x.ref!),
          shareCompany: r.shares.some((x) => x.kind === "company"),
          repeat: fieldsFromRule(r.recurrence, r.anchorLocal),
          isTask: r.isTask,
          channels: r.channels,
          slackChannelIds: refs("slack_channel"),
          // Same gap after the (next) send as before; "now" if that time has passed.
          dueLocal: r.isTask && r.dueAfterMinutes && !waiting ? toLocalInput(dueFrom(r.sendAt, r.dueAfterMinutes), r.timeZone) : "",
          // An event's end, from its (next) start and length.
          isEvent: r.isEvent,
          allDay: r.allDay,
          endLocal: r.isEvent && r.durationMinutes ? toLocalInput(new Date((occurs ?? r.sendAt).getTime() + r.durationMinutes * 60_000), r.timeZone) : "",
          endDate:
            r.isEvent && r.allDay && r.durationMinutes
              ? toLocalInput(new Date((occurs ?? r.sendAt).getTime() + (r.durationMinutes - 1440) * 60_000), r.timeZone).slice(0, 10)
              : "",
          location: r.location ?? "",
          meetingUrl: r.meetingUrl ?? "",
          notifyBefore: r.notifyBefore,
          // Saved as "Laptop (Onboarding)"; assignees that are the task's own recipients show as none picked.
          subTasks: subs.map((x, i) => ({
            id: x.id,
            title: x.title.endsWith(` (${r.title})`) ? x.title.slice(0, -r.title.length - 3) : x.title,
            dueLocal: toLocalInput(dueFrom(x.sendAt, x.dueAfterMinutes ?? 0), r.timeZone),
            userIds: keys(x.targets) === keys(r.targets) ? [] : x.targets.flatMap((t) => (t.kind === "user" ? [t.ref!] : [])),
            cover: subCovers[i],
          })),
        }}
      />
    </Page>
  );
}
