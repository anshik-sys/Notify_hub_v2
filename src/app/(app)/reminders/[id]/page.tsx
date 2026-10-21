import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, Checkbox, Columns, Field, firstParam, Form, Hint, LinkButton, Page, Section } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { Badge, Muted, Table } from "@/components/table";
import { can } from "@/lib/permissions";
import { describe } from "@/lib/recurrence";
import { deliveryLog, getReminder, isDelayed, listAttachments, mayDecide as canDecide, reminderAccess, statusLabel } from "@/lib/reminders";
import { formatSize } from "@/lib/format";
import { markReadForReminder } from "@/lib/notifications";
import { requireMember } from "@/lib/session";
import { myTaskStatus, taskProgress } from "@/lib/tasks";
import { formatInZone } from "@/lib/time";
import { eventGuests } from "@/lib/events";
import { ANSWER_LABEL, answerOpen, eventWhen } from "@/lib/invite";
import { isUuid } from "@/lib/validate";
import { cancelReminderAction, decideReminderAction, deleteReminderAction, markOccurrenceAction, markTaskAction, respondAction, sendNowAction, sendTestAction, seriesAction } from "../actions";
import { Discussion } from "./discussion";
import styles from "./page.module.css";
import { listComments } from "@/lib/comments";
import { listUsers, photoUrls } from "@/lib/users";

const DELIVERY_LABELS = { queued: "Queued", sending: "Sending", sent: "Sent", failed: "Failed" } as const;
// Server-rendered per request, so "now" is the request time.
const overdue = (dueAt: Date | null) => Boolean(dueAt && dueAt.getTime() < Date.now());
const OCCURRENCE_NOTE = { missed: "Missed: the sending service was down", skipped: "Skipped" } as const;

type DeliveryRow = Awaited<ReturnType<typeof deliveryLog>>["rows"][number];
const deliveryTable = (rows: DeliveryRow[], tz: string) => (
  <Table
    columns={["Recipient", "Channel", "Status", "Sent", "Note"]}
    rows={rows.map((d) => ({
      key: d.id,
      cells: [
        // A Slack DM row's address is the user id: show the name instead.
        d.channel === "slack" && d.userName ? d.userName : d.address,
        d.channel === "slack" ? (d.address.startsWith("C") ? "Slack channel" : "Slack DM") : "Email",
        <Badge key="s" tone={d.status === "failed" ? "danger" : d.status === "sent" ? "success" : "neutral"}>
          {/* Held by the daily email limit: still queued, nothing tried yet. */}
          {d.status === "queued" && d.lastError?.startsWith("Held:") ? "Held" : DELIVERY_LABELS[d.status]}
        </Badge>,
        d.sentAt ? formatInZone(d.sentAt, tz) : "—",
        d.lastError ? <Muted key="n">{d.attempts ? `${d.lastError} (attempt ${d.attempts})` : d.lastError}</Muted> : "",
      ],
    }))}
  />
);

export default async function ReminderDetail(props: PageProps<"/reminders/[id]">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const { user, companyId, access } = await requireMember();
  const r = await getReminder(companyId, id);
  const seeAs = r && (await reminderAccess(companyId, { id: user.id, email: user.email, access }, r));
  if (!r || !seeAs) notFound();
  // Arriving from an email or Slack link reads what I was told about it.
  await markReadForReminder(companyId, user.id, r.id);
  // Recipients see the reminder itself; the log and recipient list are for its owners.
  const log = seeAs === "full" ? await deliveryLog(companyId, r.id) : null;
  // Owners see everyone's progress on the latest occurrence; anyone assigned sees their own.
  const progress = r.isTask && log?.latest ? await taskProgress(companyId, log.latest.id) : null;
  const mine = r.isTask ? await myTaskStatus(companyId, user.id, r.id) : null;
  // PRD 14.3: answers, once guests can see it (not while waiting for approval).
  const guests = r.isEvent && ["scheduled", "paused", "sent"].includes(r.status) ? await eventGuests(companyId, r) : null;
  const myAnswer = guests?.list.find((g) => g.id === user.id && !g.organiser);
  const [files, thread, people, photos] = await Promise.all([
    listAttachments(companyId, r.id),
    listComments(companyId, r.id),
    // The mention list is the directory: only for those allowed to see it.
    can(access, "users.view")
      ? listUsers(companyId).then((x) => x.users.filter((u) => !u.deactivatedAt).map(({ id, name, email }) => ({ id, name, email })))
      : [],
    photoUrls(companyId),
  ]);
  const { error: errorParam, notice: noticeParam } = await props.searchParams;
  const [error, notice] = [firstParam(errorParam), firstParam(noticeParam)];

  const editable = ["pending_approval", "rejected", "scheduled", "paused"].includes(r.status);
  const tz = r.timeZone;
  // Same rule as mayChange in src/lib/reminders.ts: "full" already means they can see it in full.
  const owner = user.id === r.createdBy;
  const mayDelete = owner || (can(access, "reminders.edit") && seeAs === "full");
  const mayChange = editable && mayDelete;
  const mayDecide = r.status === "pending_approval" && (await canDecide(companyId, { id: user.id, access }));
  const maySendNow =
    (r.status === "scheduled" || (r.recurrence && r.status === "paused")) &&
    (owner || (can(access, "reminders.send_now") && seeAs === "full"));

  return (
    <Page
      title={r.title}
      back={seeAs === "full" ? { href: "/reminders", label: "Reminders" } : { href: "/", label: "Home" }}
      error={error}
      notice={notice}
      actions={
        mayChange && (
          <LinkButton href={`/reminders/${r.id}/edit`}>{r.recurrence ? "Edit series" : "Edit reminder"}</LinkButton>
        )
      }
    >
      <p className={styles.status}>
        <span className={styles.badge}>{statusLabel(r)}</span>
        <span>{r.shortId}</span>
        {r.tags.map((t) => (
          <Link key={t} href={`/reminders?tag=${encodeURIComponent(t)}`} className={styles.tag}>
            {t}
          </Link>
        ))}
      </p>

      {isDelayed(r) && (
        <p role="alert" className={styles.warning}>
          Delivery is delayed: the sending service isn’t running. This reminder will go out automatically, once,
          as soon as it’s back. If it stays like this, tell your admin.
        </p>
      )}
      {r.status === "pending_approval" && (
        <p role="status" className={styles.warning}>
          Waiting for an admin’s approval. Outside the sender’s departments: {r.outOfScope.join(", ")}.
        </p>
      )}
      {r.status === "rejected" && (
        <p role="status" className={styles.warning}>
          Not approved: {r.rejectionReason}. Edit it to submit again.
        </p>
      )}

      <Columns
        main={
          <>
            <Section title="Details">
              {/* PRD 14.3: an event's when, where and meeting link. */}
              {r.isEvent && r.durationMinutes && (
                <>
                  {/* The repeat rule has its own line below. */}
                  <Hint>Event: {eventWhen({ ...r, recurrence: null })}</Hint>
                  {r.location && <Hint>Where: {r.location}</Hint>}
                  {r.meetingUrl && (
                    <Hint>
                      Meeting link:{" "}
                      <a href={r.meetingUrl} rel="noopener noreferrer" target="_blank">
                        {r.meetingUrl}
                      </a>
                    </Hint>
                  )}
                </>
              )}
              {r.recurrence ? (
                <>
                  <Hint>Repeats: {describe(r.recurrence, r.anchorLocal)}</Hint>
                  <Hint>
                    {r.status === "paused"
                      ? "Paused: nothing is sent until it’s resumed."
                      : r.status === "sent"
                        ? "Ended: no more occurrences."
                        : `Next: ${formatInZone(r.sendAt, tz)} (${tz})`}
                  </Hint>
                </>
              ) : r.isEvent ? null : (
                <Hint>
                  {r.status === "sent" ? "Sent" : "Sends"} {formatInZone(r.sendAt, tz)} ({tz})
                </Hint>
              )}
              <Hint>
                From “{r.senderName}”, created by {r.creatorName}
              </Hint>
              {r.description && <p className={styles.description}>{r.description}</p>}
              {(files.length > 0 || r.links.length > 0) && (
                <List>
                  {files.map((f) => (
                    // A plain link: an API route that always downloads (never next/link).
                    <ListRow key={f.id} title={<a href={`/api/attachments/${f.id}`}>{f.fileName}</a>} meta={formatSize(f.size)} />
                  ))}
                  {r.links.map((l, i) => (
                    <ListRow key={`l${i}`} title={<a href={l.url} rel="noopener noreferrer" target="_blank">{l.label}</a>} meta={l.url} />
                  ))}
                </List>
              )}
            </Section>

            {progress && progress.total > 0 && log?.latest && (
              <Section title={`Task: ${progress.done} of ${progress.total} done`}>
                {log.latest.dueAt && (
                  <Hint>
                    Due {formatInZone(log.latest.dueAt, tz)}
                    {r.recurrence ? " (this occurrence)" : ""}
                  </Hint>
                )}
                <Table
                  columns={["Person", "Status", "Done at", "Follow-ups"]}
                  rows={progress.rows.map((p) => ({
                    key: p.assignmentId,
                    cells: [
                      <span key="p" title={p.email}>
                        {p.name}
                      </span>,
                      p.doneAt ? (
                        <Badge key="s" tone="success">
                          Done
                        </Badge>
                      ) : overdue(log.latest!.dueAt) ? (
                        <Badge key="s" tone="danger">
                          Overdue
                        </Badge>
                      ) : (
                        <Badge key="s">Not done</Badge>
                      ),
                      p.doneAt ? formatInZone(p.doneAt, tz) : "—",
                      p.followups,
                    ],
                  }))}
                />
              </Section>
            )}

            {log?.latest && log.rows.length > 0 && (
              <Section title={r.recurrence ? `Delivery: ${formatInZone(log.latest.occursAt, tz)}` : "Delivery"}>
                <Hint>
                  {log.latest.sent} sent · {log.latest.failed} failed · {log.latest.pending} pending
                </Hint>
                {log.latest.snapshot && (
                  <details className={styles.more}>
                    <summary className={styles.moreToggle}>Message as sent</summary>
                    <Hint>
                      “{log.latest.snapshot.title}” from “{log.latest.snapshot.senderName}”
                    </Hint>
                    {log.latest.snapshot.description && <p className={styles.description}>{log.latest.snapshot.description}</p>}
                    {log.latest.snapshot.links.map((l, i) => (
                      <Hint key={i}>
                        {l.label}: {l.url}
                      </Hint>
                    ))}
                  </details>
                )}
                {deliveryTable(log.rows, tz)}
                {r.recurrence && log.history.length > 0 && (
                  // Native <details>: folded by default, no client JS.
                  <details className={styles.more}>
                    <summary className={styles.moreToggle}>Earlier occurrences ({log.history.length})</summary>
                    <Table
                      columns={["Occurrence", "Sent as", "Result"]}
                      rows={log.history.map((o) => ({
                        key: o.id,
                        cells: [
                          formatInZone(o.occursAt, tz),
                          o.snapshot?.title ?? "—",
                          o.status === "missed" || o.status === "skipped" ? (
                            <Muted key="r">{OCCURRENCE_NOTE[o.status]}</Muted>
                          ) : (
                            `${o.sent} sent · ${o.failed} failed${o.pending ? ` · ${o.pending} pending` : ""}`
                          ),
                        ],
                      }))}
                    />
                  </details>
                )}
              </Section>
            )}

            {log && log.invites.length > 0 && (
              <Section title="Invites">
                <Hint>
                  {log.invites.filter((d) => d.status === "sent").length} sent · {log.invites.filter((d) => d.status === "failed").length} failed ·{" "}
                  {log.invites.filter((d) => d.status === "queued" || d.status === "sending").length} pending
                </Hint>
                {deliveryTable(log.invites, tz)}
              </Section>
            )}

            <Discussion
              reminderId={r.id}
              timeZone={tz}
              thread={thread}
              people={people}
              photos={photos}
              viewerId={user.id}
              canModerate={can(access, "comments.delete_any")}
            />
          </>
        }
        side={
          <>
            {myAnswer && (
              <Section title="Going?">
                <Hint>
                  {myAnswer.answer ? `Your answer: ${ANSWER_LABEL[myAnswer.answer]}.` : "You haven’t answered yet."}
                  {answerOpen(r) ? " You can change it until the event ends." : " The event has ended."}
                </Hint>
                {answerOpen(r) && (
                  <form action={respondAction} className={styles.answers}>
                    <input type="hidden" name="id" value={r.id} />
                    {(["yes", "maybe", "no"] as const).map((a) => (
                      <Button key={a} name="answer" value={a} variant={a === myAnswer.answer ? "primary" : "secondary"} aria-pressed={a === myAnswer.answer}>
                        {ANSWER_LABEL[a]}
                      </Button>
                    ))}
                  </form>
                )}
              </Section>
            )}

            {guests && (
              <Section title="Guests">
                <Hint>
                  {guests.counts.yes} yes · {guests.counts.maybe} maybe · {guests.counts.no} no · {guests.counts.none} no answer yet
                </Hint>
                {/* RS4 / RS5: names for the organiser and those who see it in full; guests see the totals. */}
                {seeAs === "full" && (
                  <List>
                    {guests.list.map((g) => (
                      <ListRow key={g.id} title={g.name} meta={g.organiser ? "Organiser" : undefined} badge={g.answer ? ANSWER_LABEL[g.answer] : "No answer yet"} />
                    ))}
                  </List>
                )}
              </Section>
            )}

            {mine && (
              <Section title="Your task">
                <Hint>
                  {mine.doneAt
                    ? `Done ${formatInZone(mine.doneAt, tz)}`
                    : `${overdue(mine.dueAt) ? "Overdue: was due" : "Due"} ${mine.dueAt ? formatInZone(mine.dueAt, tz) : ""}`}
                </Hint>
                <form action={markTaskAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="assignmentId" value={mine.assignmentId} />
                  <input type="hidden" name="done" value={mine.doneAt ? "false" : "true"} />
                  <Button variant={mine.doneAt ? "secondary" : "primary"}>{mine.doneAt ? "Undo: not done yet" : "Mark done"}</Button>
                </form>
              </Section>
            )}

            {/* PRD 5.8: nobody in the company is assigned (sent only outside, or an announcement): one shared done. */}
            {mayDelete && log?.latest && (!r.isTask || progress?.total === 0) && (
              <Section title={r.isTask ? "Task" : "Complete"}>
                <Hint>
                  {log.latest.doneAt
                    ? `${r.isTask ? "Done" : "Completed"} ${formatInZone(log.latest.doneAt, tz)}`
                    : r.isTask
                      ? "Sent only outside the company, so you mark it done for everyone."
                      : "Mark it complete once it’s been dealt with."}
                  {r.recurrence ? " (this occurrence)" : ""}
                </Hint>
                <form action={markOccurrenceAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="occurrenceId" value={log.latest.id} />
                  <input type="hidden" name="done" value={log.latest.doneAt ? "false" : "true"} />
                  <Button variant={log.latest.doneAt ? "secondary" : "primary"}>
                    {log.latest.doneAt ? "Undo" : r.isTask ? "Mark done" : "Mark complete"}
                  </Button>
                </form>
              </Section>
            )}

            {mayDecide && (
              <Section title="Approval">
                <Form action={decideReminderAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <Button name="decision" value="approve">
                    Approve and schedule
                  </Button>
                </Form>
                <Form action={decideReminderAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <Field label="Reason for rejecting" name="reason" maxLength={500} required />
                  <Button name="decision" value="reject" variant="danger">
                    Reject
                  </Button>
                </Form>
              </Section>
            )}

            {(seeAs === "full" || mayDelete) && (
              <Section title="Actions">
                {seeAs === "full" && !r.isEvent && (
                  <form action={sendTestAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <Button variant="secondary">Send me a test</Button>
                  </form>
                )}
                {maySendNow && !r.isEvent && (
                  <Form action={sendNowAction}>
                    <input type="hidden" name="id" value={r.id} />
                    {/* A required checkbox stands in for a confirm dialog, without client JS. */}
                    <Checkbox
                      label={r.recurrence ? "Send it to all recipients now (the schedule stays as it is)" : "Send it to all recipients now instead of at the scheduled time"}
                      required
                    />
                    <Button>Send now</Button>
                  </Form>
                )}
                {mayChange && r.recurrence && (r.status === "scheduled" || r.status === "paused") && (
                  <form action={seriesAction} className={styles.seriesButtons}>
                    <input type="hidden" name="id" value={r.id} />
                    <Button variant="secondary" name="op" value={r.status === "paused" ? "resume" : "pause"}>
                      {r.status === "paused" ? "Resume" : "Pause"}
                    </Button>
                    <Button variant="secondary" name="op" value="skip">
                      Skip the next one ({formatInZone(r.sendAt, tz)})
                    </Button>
                  </form>
                )}
                {mayChange && (
                  <form action={cancelReminderAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <Button variant="secondary">{r.recurrence ? "Cancel the whole series" : "Cancel reminder"}</Button>
                  </form>
                )}
                {mayDelete && (
                  <Form action={deleteReminderAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <Checkbox label="Delete it for everyone, with its delivery log and comments. This can’t be undone." required />
                    <Button variant="danger">Delete reminder</Button>
                  </Form>
                )}
              </Section>
            )}

            {seeAs === "full" && (
              <Section title="Recipients">
                <List>
                  {r.targetLabels.map((label, i) =>
                    r.targets[i].kind === "email" && r.unsubscribed.includes(r.targets[i].ref!) ? (
                      <ListRow key={i} title={label} meta="Won’t receive this" badge="Unsubscribed" />
                    ) : (
                      <ListRow key={i} title={label} />
                    ),
                  )}
                </List>
                <Hint>
                  {r.shareLabels.length ? `Also visible to ${r.shareLabels.join(", ")}, as well as` : "Visible only to"} the creator, their managers,
                  admins and everyone it’s sent to.
                </Hint>
              </Section>
            )}

            {!mayChange && user.id === r.createdBy && r.status === "cancelled" && (
              <Hint>
                This reminder was cancelled. <Link href="/reminders/new">Create a new one</Link>
              </Hint>
            )}
          </>
        }
      />
    </Page>
  );
}
