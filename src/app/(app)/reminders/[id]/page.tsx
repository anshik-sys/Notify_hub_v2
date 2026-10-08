import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, Checkbox, Field, firstParam, Form, Hint, LinkButton, Page, Section } from "@/components/form";
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
import { isUuid } from "@/lib/validate";
import { cancelReminderAction, decideReminderAction, markTaskAction, sendNowAction, sendTestAction, seriesAction } from "../actions";
import { Discussion } from "./discussion";
import styles from "./page.module.css";
import { listComments } from "@/lib/comments";
import { listUsers } from "@/lib/users";

const DELIVERY_LABELS = { queued: "Queued", sending: "Sending", sent: "Sent", failed: "Failed" } as const;
// Server-rendered per request, so "now" is the request time.
const overdue = (dueAt: Date | null) => Boolean(dueAt && dueAt.getTime() < Date.now());
const OCCURRENCE_NOTE = { missed: "Missed: the sending service was down", skipped: "Skipped" } as const;

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
  const [files, thread, people] = await Promise.all([
    listAttachments(companyId, r.id),
    listComments(companyId, r.id),
    // The mention list is the directory: only for those allowed to see it.
    can(access, "users.view")
      ? listUsers(companyId).then((x) => x.users.filter((u) => !u.deactivatedAt).map(({ id, name, email }) => ({ id, name, email })))
      : [],
  ]);
  const { error: errorParam, notice: noticeParam } = await props.searchParams;
  const [error, notice] = [firstParam(errorParam), firstParam(noticeParam)];

  const editable = ["pending_approval", "rejected", "scheduled", "paused"].includes(r.status);
  const tz = r.timeZone;
  const mayChange = editable && (user.id === r.createdBy || can(access, "reminders.edit"));
  const mayDecide = r.status === "pending_approval" && (await canDecide(companyId, { id: user.id, access }));
  const maySendNow =
    (r.status === "scheduled" || (r.recurrence && r.status === "paused")) &&
    (user.id === r.createdBy || can(access, "reminders.send_now"));

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

      <Section title="Details">
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
        ) : (
          <Hint>
            {r.status === "sent" ? "Sent" : "Sends"} {formatInZone(r.sendAt, tz)} ({tz})
          </Hint>
        )}
        <Hint>
          From “{r.senderName}”, created by {r.creatorName}
        </Hint>
        {r.description && <p className={styles.description}>{r.description}</p>}
      </Section>

      {files.length > 0 && (
        <Section title="Attachments">
          <List>
            {files.map((f) => (
              // A plain link: an API route that always downloads (never next/link).
              <ListRow key={f.id} title={<a href={`/api/attachments/${f.id}`}>{f.fileName}</a>} meta={formatSize(f.size)} />
            ))}
          </List>
        </Section>
      )}

      {r.links.length > 0 && (
        <Section title="Links">
          <List>
            {r.links.map((l, i) => (
              <ListRow key={i} title={<a href={l.url} rel="noopener noreferrer" target="_blank">{l.label}</a>} meta={l.url} />
            ))}
          </List>
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

      {progress && log?.latest && (
        <Section title={`Task: ${progress.done} of ${progress.total} done`}>
          {log.latest.dueAt && (
            <Hint>
              Due {formatInZone(log.latest.dueAt, tz)}
              {r.recurrence ? " (this occurrence)" : ""}
            </Hint>
          )}
          <Table
            columns={["Person", "Email", "Status", "Done at", "Follow-ups"]}
            rows={progress.rows.map((p) => ({
              key: p.assignmentId,
              cells: [
                p.name,
                <Muted key="e">{p.email}</Muted>,
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

      {seeAs === "full" && (
        <Section title="Recipients">
          <List>
            {r.targetLabels.map((label, i) => (
              <ListRow key={i} title={label} />
            ))}
          </List>
        </Section>
      )}

      {seeAs === "full" && (
        <Section title="Who can see it">
          <Hint>
            {r.shareLabels.length
              ? `Shared with ${r.shareLabels.join(", ")}, as well as`
              : "Private:"}{" "}
            the creator, their managers, admins and everyone it’s sent to.
          </Hint>
        </Section>
      )}

      {log?.latest && log.rows.length > 0 && (
        <Section title={r.recurrence ? `Latest: ${formatInZone(log.latest.occursAt, tz)}` : "Delivery"}>
          <Hint>
            {log.latest.sent} sent · {log.latest.failed} failed · {log.latest.pending} pending
          </Hint>
          <Table
            columns={["Recipient", "Channel", "Status", "Sent", "Note"]}
            rows={log.rows.map((d) => ({
              key: d.id,
              cells: [
                // A Slack DM row's address is the user id: show the name instead.
                d.channel === "slack" && d.userName ? d.userName : d.address,
                d.channel === "slack" ? (d.address.startsWith("C") ? "Slack channel" : "Slack DM") : "Email",
                <Badge key="s" tone={d.status === "failed" ? "danger" : d.status === "sent" ? "success" : "neutral"}>
                  {DELIVERY_LABELS[d.status]}
                </Badge>,
                d.sentAt ? formatInZone(d.sentAt, tz) : "—",
                d.lastError ? <Muted key="n">{`${d.lastError} (attempt ${d.attempts})`}</Muted> : "",
              ],
            }))}
          />
        </Section>
      )}

      {log && r.recurrence && log.history.length > 0 && (
        <Section title="Earlier occurrences">
          <Table
            columns={["Occurrence", "Result"]}
            rows={log.history.map((o) => ({
              key: o.id,
              cells: [
                formatInZone(o.occursAt, tz),
                o.status === "missed" || o.status === "skipped" ? (
                  <Muted key="r">{OCCURRENCE_NOTE[o.status]}</Muted>
                ) : (
                  `${o.sent} sent · ${o.failed} failed${o.pending ? ` · ${o.pending} pending` : ""}`
                ),
              ],
            }))}
          />
        </Section>
      )}

      {seeAs === "full" && (
        <Section title="Send">
          <div className={styles.sendRow}>
            <form action={sendTestAction}>
              <input type="hidden" name="id" value={r.id} />
              <Button variant="secondary">Send me a test</Button>
            </form>
          </div>
          {maySendNow && (
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

      {mayChange && (
        <Section title={r.recurrence ? "Series" : "Change"}>
          {r.recurrence && (r.status === "scheduled" || r.status === "paused") && (
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
          <form action={cancelReminderAction}>
            <input type="hidden" name="id" value={r.id} />
            <Button variant="secondary">{r.recurrence ? "Cancel the whole series" : "Cancel reminder"}</Button>
          </form>
        </Section>
      )}

      {!mayChange && user.id === r.createdBy && r.status === "cancelled" && (
        <Hint>
          This reminder was cancelled. <Link href="/reminders/new">Create a new one</Link>
        </Hint>
      )}
      <Discussion
        reminderId={r.id}
        timeZone={tz}
        thread={thread}
        people={people}
        viewerId={user.id}
        canModerate={can(access, "comments.delete_any")}
      />
    </Page>
  );
}
