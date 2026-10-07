import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, Field, firstParam, Form, Hint, LinkButton, Page, Section } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { can } from "@/lib/permissions";
import { canSeeReminder, getReminder, STATUS_LABELS } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";
import { isUuid } from "@/lib/validate";
import { cancelReminderAction, decideReminderAction } from "../actions";
import styles from "./page.module.css";

export default async function ReminderDetail(props: PageProps<"/reminders/[id]">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const { user, companyId, company, access } = await requireMember();
  const r = await getReminder(companyId, id);
  if (!r || !(await canSeeReminder(companyId, { id: user.id, access }, r.createdBy))) notFound();
  const error = firstParam((await props.searchParams).error);

  const editable = ["pending_approval", "rejected", "scheduled"].includes(r.status);
  const mayChange = editable && (user.id === r.createdBy || can(access, "reminders.edit"));
  const mayDecide = r.status === "pending_approval" && can(access, "reminders.approve");

  return (
    <Page title={r.title} back={{ href: "/reminders", label: "Reminders" }} error={error}>
      <p className={styles.status}>
        <span className={styles.badge}>{STATUS_LABELS[r.status]}</span>
        <span>{r.shortId}</span>
      </p>

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
        <Hint>
          {r.status === "sent" ? "Sent" : "Sends"} {formatInZone(r.sendAt, company.timeZone)} ({company.timeZone})
        </Hint>
        <Hint>
          From “{r.senderName}”, created by {r.creatorName}
        </Hint>
        {r.description && <p className={styles.description}>{r.description}</p>}
      </Section>

      {r.links.length > 0 && (
        <Section title="Links">
          <List>
            {r.links.map((l, i) => (
              <ListRow key={i} title={<a href={l.url} rel="noopener noreferrer" target="_blank">{l.label}</a>} meta={l.url} />
            ))}
          </List>
        </Section>
      )}

      <Section title="Recipients">
        <List>
          {r.targetLabels.map((label, i) => (
            <ListRow key={i} title={label} />
          ))}
        </List>
      </Section>

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
        <Section title="Change">
          <LinkButton href={`/reminders/${r.id}/edit`}>Edit reminder</LinkButton>
          <form action={cancelReminderAction}>
            <input type="hidden" name="id" value={r.id} />
            <Button variant="secondary">Cancel reminder</Button>
          </form>
        </Section>
      )}

      {!mayChange && user.id === r.createdBy && r.status === "cancelled" && (
        <Hint>
          This reminder was cancelled. <Link href="/reminders/new">Create a new one</Link>
        </Hint>
      )}
    </Page>
  );
}
