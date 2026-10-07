import { and, asc, eq, lt, lte, sql } from "drizzle-orm";
import { deliveries, reminderOccurrences, reminders, reminderTargets, slackInstallations, taskAssignments, user } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { lookupByEmail, openDm, postMessage, reminderMessage, SlackError } from "@/lib/slack";
import { between, nextAfter } from "@/lib/recurrence";
import { formatInZone } from "@/lib/time";
import { sendMail } from "@/lib/mail";
import { resolveRecipients } from "@/lib/recipients";
import { ownerDb } from "./db";

// Exactly once per (occurrence, person), in three steps:
// 1. dispatchDue: a due reminder gets an occurrence row (unique per reminder
//    and time) and one `deliveries` row per recipient (unique per occurrence
//    and email). SKIP LOCKED keeps overlapping runs off the same reminder.
// 2. deliverOne: claims a row queued -> sending in one UPDATE (only one caller
//    can win), sends, marks it sent.
// 3. sweep: a row stuck in `sending` (worker died mid-send) is marked failed,
//    never resent: we can't know if the mail left, and the PRD says never twice.

export const MAX_ATTEMPTS = 5;
const STUCK_AFTER_MS = 10 * 60_000;

// Returns how many reminders were dispatched; enqueue gets the new delivery ids.
// onlyCompany and now are for tests: a test run never dispatches anyone else's
// reminders, and a test reminder due "in an hour" is invisible to a live worker.
export async function dispatchDue(
  enqueue: (deliveryIds: string[]) => Promise<void>,
  onlyCompany?: string,
  now = new Date(),
) {
  let count = 0;
  for (;;) {
    const ids = await ownerDb.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(reminders)
        .where(
          and(
            eq(reminders.status, "scheduled"),
            lte(reminders.sendAt, now),
            onlyCompany ? eq(reminders.companyId, onlyCompany) : undefined,
          ),
        )
        .orderBy(asc(reminders.sendAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!r) return null;

      // Which occurrence goes out now, and when the next one is. If the worker
      // was down and several came due, only the latest is sent; the earlier
      // ones are recorded as missed (decided with the user: no stale floods).
      let toSend = r.sendAt;
      let missed: Date[] = [];
      let next: Date | null = null;
      if (r.recurrence) {
        const due = between(r.recurrence, r.anchorLocal, r.timeZone, r.sendAt, now);
        if (due.length) [toSend, missed] = [due.at(-1)!, due.slice(0, -1)];
        next = nextAfter(r.recurrence, r.anchorLocal, r.timeZone, now);
      }
      const occurrence = (occursAt: Date, status: "sending" | "missed") => ({
        companyId: r.companyId,
        reminderId: r.id,
        occursAt,
        status,
        // Tasks: each occurrence is due the same time after it's sent.
        dueAt: r.isTask && r.dueAfterMinutes ? new Date(occursAt.getTime() + r.dueAfterMinutes * 60_000) : null,
      });
      if (missed.length)
        await tx
          .insert(reminderOccurrences)
          .values(missed.map((at) => occurrence(at, "missed")))
          .onConflictDoNothing();
      // Nothing returned = this occurrence already exists (the user skipped it): don't send.
      const [occ] = await tx
        .insert(reminderOccurrences)
        .values(occurrence(toSend, "sending"))
        .onConflictDoNothing()
        .returning({ id: reminderOccurrences.id });

      let deliveryIds: string[] = [];
      if (occ) {
        const targets = await tx
          .select({ kind: reminderTargets.kind, ref: reminderTargets.ref })
          .from(reminderTargets)
          .where(eq(reminderTargets.reminderId, r.id));
        const { users, external } = await resolveRecipients(tx, r.companyId, targets);
        type Row = { channel: "email" | "slack"; address: string; userId: string | null };
        const rows: Row[] = [];
        if (r.channels.includes("email"))
          rows.push(
            ...users.map((u) => ({ channel: "email" as const, address: u.email, userId: u.id })),
            ...external.map((address) => ({ channel: "email" as const, address, userId: null })),
          );
        if (r.channels.includes("slack")) {
          // Company-wide on Slack goes to channels only, never a DM to everyone (PRD 5.3).
          if (!targets.some((t) => t.kind === "company"))
            rows.push(...users.map((u) => ({ channel: "slack" as const, address: u.id, userId: u.id })));
          rows.push(
            ...targets
              .filter((t) => t.kind === "slack_channel")
              .map((t) => ({ channel: "slack" as const, address: t.ref!, userId: null })),
          );
        }
        // A task's assignees: every internal recipient, once, whatever the channels.
        if (r.isTask && users.length)
          await tx
            .insert(taskAssignments)
            .values(users.map((u) => ({ companyId: r.companyId, reminderId: r.id, occurrenceId: occ.id, userId: u.id })))
            .onConflictDoNothing();
        const deliveryRows = rows.map((x) => ({ ...x, companyId: r.companyId, reminderId: r.id, occurrenceId: occ.id }));
        if (deliveryRows.length)
          deliveryIds = (
            await tx.insert(deliveries).values(deliveryRows).onConflictDoNothing().returning({ id: deliveries.id })
          ).map((d) => d.id);
        // Nobody left to send to (everyone deactivated since): done, with an empty log.
        else await tx.update(reminderOccurrences).set({ status: "sent" }).where(eq(reminderOccurrences.id, occ.id));
      }

      // A series with more to come stays scheduled at its next occurrence;
      // otherwise the reminder finishes once this occurrence's sends are done.
      await tx
        .update(reminders)
        .set(next ? { sendAt: next } : { status: deliveryIds.length ? "sending" : "sent" })
        .where(eq(reminders.id, r.id));
      return deliveryIds;
    });
    if (ids === null) return count;
    count++;
    if (ids.length) await enqueue(ids);
  }
}

const inFlight = sql`('queued','sending')`;

// An occurrence is sent once none of its deliveries is still in flight.
async function finishOccurrence(occurrenceId: string) {
  await ownerDb
    .update(reminderOccurrences)
    .set({ status: "sent" })
    .where(
      and(
        eq(reminderOccurrences.id, occurrenceId),
        eq(reminderOccurrences.status, "sending"),
        sql`not exists (select 1 from ${deliveries} where ${deliveries.occurrenceId} = ${occurrenceId} and ${deliveries.status} in ${inFlight})`,
      ),
    );
}

// A one-time reminder (or a series past its last occurrence) is sent once
// nothing of it is in flight. A series with a next occurrence stays scheduled.
async function finishReminder(reminderId: string) {
  await ownerDb
    .update(reminders)
    .set({ status: "sent" })
    .where(
      and(
        eq(reminders.id, reminderId),
        eq(reminders.status, "sending"),
        sql`not exists (select 1 from ${deliveries} where ${deliveries.reminderId} = ${reminderId} and ${deliveries.status} in ${inFlight})`,
      ),
    );
}

async function finish(d: { occurrenceId: string; reminderId: string }) {
  await finishOccurrence(d.occurrenceId);
  await finishReminder(d.reminderId);
}

// A failure that retrying can't fix: fail now instead of burning attempts.
class Permanent extends Error {}
const PERMANENT_SLACK = new Set(["channel_not_found", "is_archived", "invalid_auth", "token_revoked", "account_inactive", "not_in_channel"]);

type Delivery = typeof deliveries.$inferSelect;
type Loaded = { reminder: typeof reminders.$inferSelect; creatorEmail: string; dueAt: Date | null };

async function sendEmail(d: Delivery, r: Loaded, send: typeof sendMail) {
  const task = r.reminder.isTask && r.dueAt;
  const body = r.reminder.description || r.reminder.title;
  await send({
    to: d.address,
    subject: task ? `Task: ${r.reminder.title}` : r.reminder.title,
    text: task ? `${body}\n\nDue ${formatInZone(r.dueAt!, r.reminder.timeZone)} (${r.reminder.timeZone}).` : body,
    links: [
      ...r.reminder.links,
      {
        label: task ? "Mark it done in NotifyHub" : "Open in NotifyHub",
        url: `${process.env.BETTER_AUTH_URL}/reminders/${r.reminder.id}`,
      },
    ],
    fromName: `${r.reminder.senderName} via NotifyHub`,
    replyTo: r.creatorEmail,
  });
  return {};
}

// A DM (address = internal user id) or a channel post (address = channel id).
// Someone with no Slack account: posted to the fallback channel with a note.
async function sendSlack(d: Delivery, r: Loaded, f?: typeof fetch) {
  const [inst] = await ownerDb.select().from(slackInstallations).where(eq(slackInstallations.companyId, d.companyId));
  if (!inst) throw new Permanent("Slack isn't connected.");
  const token = decrypt(inst.botTokenEnc);
  let channel = d.address;
  let note: string | undefined;
  if (d.userId) {
    const [u] = await ownerDb.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, d.userId));
    const slackUser = await lookupByEmail(token, u.email, f);
    if (slackUser) channel = await openDm(token, slackUser, f);
    else if (inst.fallbackChannelId) {
      channel = inst.fallbackChannelId;
      note = `For ${u.name}: they have no Slack account under ${u.email}, so this is posted here.`;
    } else throw new Permanent(`No Slack account for ${u.email}, and no fallback channel is set.`);
  }
  const msg = reminderMessage({
    title: r.reminder.title,
    description: r.reminder.description,
    links: r.reminder.links,
    appUrl: `${process.env.BETTER_AUTH_URL}/reminders/${r.reminder.id}`,
    due: r.reminder.isTask && r.dueAt ? `${formatInZone(r.dueAt, r.reminder.timeZone)} (${r.reminder.timeZone})` : undefined,
    note,
  });
  try {
    const posted = await postMessage(token, channel, msg.text, msg.blocks, f);
    return {
      slackChannel: posted.channel,
      slackTs: posted.ts,
      lastError: note ? `Sent to #${inst.fallbackChannelName ?? "fallback"}: not on Slack` : null,
    };
  } catch (e) {
    if (e instanceof SlackError && PERMANENT_SLACK.has(e.code)) throw new Permanent(`Slack: ${e.code}`);
    throw e;
  }
}

// slackFetch is for tests (a fake Slack); production uses the real fetch.
export async function deliverOne(deliveryId: string, send: typeof sendMail = sendMail, slackFetch?: typeof fetch) {
  const [d] = await ownerDb
    .update(deliveries)
    .set({ status: "sending", attempts: sql`${deliveries.attempts} + 1` })
    .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "queued")))
    .returning();
  if (!d) return "skipped"; // sent, failed, or another worker has it

  const [r] = await ownerDb
    .select({ reminder: reminders, creatorEmail: user.email, dueAt: reminderOccurrences.dueAt })
    .from(reminders)
    .innerJoin(user, eq(user.id, reminders.createdBy))
    .innerJoin(reminderOccurrences, eq(reminderOccurrences.id, d.occurrenceId))
    .where(eq(reminders.id, d.reminderId));
  let result: { slackChannel?: string; slackTs?: string; lastError?: string | null };
  try {
    result = d.channel === "slack" ? await sendSlack(d, r, slackFetch) : await sendEmail(d, r, send);
  } catch (e) {
    const final = e instanceof Permanent || d.attempts >= MAX_ATTEMPTS;
    await ownerDb
      .update(deliveries)
      .set({ status: final ? "failed" : "queued", lastError: String((e as Error).message ?? e).slice(0, 500) })
      .where(eq(deliveries.id, d.id));
    if (final) {
      await finish(d);
      return "failed";
    }
    throw e; // pg-boss retries with backoff (Slack 429s included)
  }
  await ownerDb
    .update(deliveries)
    .set({ status: "sent", sentAt: new Date(), lastError: null, ...result })
    .where(eq(deliveries.id, d.id));
  await finish(d);
  return "sent";
}

// Each tick: fail rows stuck in `sending`, and return queued rows that lost
// their job (e.g. enqueue failed after dispatch committed) for re-enqueueing.
export async function sweep() {
  const stuck = await ownerDb
    .update(deliveries)
    .set({ status: "failed", lastError: "Outcome unknown: the worker stopped mid-send. Not resent, to avoid a duplicate." })
    .where(and(eq(deliveries.status, "sending"), lt(deliveries.updatedAt, new Date(Date.now() - STUCK_AFTER_MS))))
    .returning({ reminderId: deliveries.reminderId, occurrenceId: deliveries.occurrenceId });
  for (const d of stuck) await finish(d);

  const orphans = await ownerDb
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(and(eq(deliveries.status, "queued"), lt(deliveries.updatedAt, new Date(Date.now() - 2 * 60_000))));
  return orphans.map((o) => o.id);
}

// --- Task follow-ups (PRD 5.8) ------------------------------------------------
// Once a day, at the company's follow-up time (its own zone), every assignee
// of an overdue task who hasn't marked it done gets one reminder. The claim is
// an UPDATE that stamps last_followup_on with the company-local date, so a
// second tick (or worker) the same day matches nothing.

// now and onlyCompany are for tests: move the clock, and never touch (stamp)
// another company's assignments, which would block their real follow-ups.
export async function claimFollowUps(now = new Date(), onlyCompany?: string) {
  const { rows } = await ownerDb.execute<{ id: string }>(sql`
    with slots as (
      select c.id as company_id,
             (${now}::timestamptz at time zone c.time_zone)::date as local_today,
             (((${now}::timestamptz at time zone c.time_zone)::date + c.follow_up_time::time) at time zone c.time_zone) as slot
      from companies c
      where ${onlyCompany ?? null}::uuid is null or c.id = ${onlyCompany ?? null}::uuid
    )
    update task_assignments a
       set last_followup_on = s.local_today, followups = a.followups + 1
      from reminder_occurrences o, reminders r, slots s, "user" u
     where o.id = a.occurrence_id and r.id = a.reminder_id and s.company_id = a.company_id and u.id = a.user_id
       and r.is_task and r.status <> 'cancelled'
       and a.done_at is null and u.deactivated_at is null
       and ${now}::timestamptz >= s.slot and o.due_at <= s.slot
       and (a.last_followup_on is null or a.last_followup_on < s.local_today)
    returning a.id`);
  return rows.map((r) => r.id);
}

// Sends one assignment's follow-up over the task's channels (email here;
// Slack DMs join in phase B).
export async function followUpOne(assignmentId: string, send: typeof sendMail = sendMail) {
  const [x] = await ownerDb
    .select({ a: taskAssignments, r: reminders, dueAt: reminderOccurrences.dueAt, email: user.email })
    .from(taskAssignments)
    .innerJoin(reminders, eq(reminders.id, taskAssignments.reminderId))
    .innerJoin(reminderOccurrences, eq(reminderOccurrences.id, taskAssignments.occurrenceId))
    .innerJoin(user, eq(user.id, taskAssignments.userId))
    .where(eq(taskAssignments.id, assignmentId));
  // Marked done (or cancelled) between the claim and now: nothing to nag about.
  if (!x || x.a.doneAt || x.r.status === "cancelled" || !x.dueAt) return "skipped";
  if (!x.r.channels.includes("email")) return "skipped"; // ponytail: Slack follow-up DMs arrive in phase B
  const [creator] = await ownerDb.select({ email: user.email }).from(user).where(eq(user.id, x.r.createdBy));
  await send({
    to: x.email,
    subject: `Overdue: ${x.r.title}`,
    text: `This task was due ${formatInZone(x.dueAt, x.r.timeZone)} (${x.r.timeZone}) and isn't marked done yet. You'll get this reminder daily until it is.`,
    links: [{ label: "Mark it done in NotifyHub", url: `${process.env.BETTER_AUTH_URL}/reminders/${x.r.id}` }],
    fromName: `${x.r.senderName} via NotifyHub`,
    replyTo: creator?.email,
  });
  return "sent";
}
