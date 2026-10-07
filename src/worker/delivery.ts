import { and, asc, eq, lt, lte, sql } from "drizzle-orm";
import { deliveries, reminders, reminderTargets, user } from "@/db/schema";
import { sendMail } from "@/lib/mail";
import { resolveRecipients } from "@/lib/recipients";
import { ownerDb } from "./db";

// Exactly once, in three steps:
// 1. dispatchDue: a due reminder becomes one `deliveries` row per recipient.
//    SKIP LOCKED keeps overlapping runs off the same reminder, and
//    unique(reminder_id, email) makes a second row for a person impossible.
// 2. deliverOne: claims a row queued -> sending in one UPDATE (only one caller
//    can win), sends, marks it sent.
// 3. sweep: a row stuck in `sending` (worker died mid-send) is marked failed,
//    never resent: we can't know if the mail left, and the PRD says never twice.

export const MAX_ATTEMPTS = 5;
const STUCK_AFTER_MS = 10 * 60_000;

// Returns how many reminders were dispatched; enqueue gets the new delivery ids.
// onlyCompany is for tests, so a test run never dispatches anyone else's reminders.
export async function dispatchDue(enqueue: (deliveryIds: string[]) => Promise<void>, onlyCompany?: string) {
  let count = 0;
  for (;;) {
    const ids = await ownerDb.transaction(async (tx) => {
      const [r] = await tx
        .select({ id: reminders.id, companyId: reminders.companyId })
        .from(reminders)
        .where(
          and(
            eq(reminders.status, "scheduled"),
            lte(reminders.sendAt, new Date()),
            onlyCompany ? eq(reminders.companyId, onlyCompany) : undefined,
          ),
        )
        .orderBy(asc(reminders.sendAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!r) return null;
      const targets = await tx
        .select({ kind: reminderTargets.kind, ref: reminderTargets.ref })
        .from(reminderTargets)
        .where(eq(reminderTargets.reminderId, r.id));
      const { users, external } = await resolveRecipients(tx, r.companyId, targets);
      const rows = [
        ...users.map((u) => ({ email: u.email, userId: u.id })),
        ...external.map((email) => ({ email, userId: null })),
      ].map((x) => ({ ...x, companyId: r.companyId, reminderId: r.id }));
      const inserted = rows.length
        ? await tx.insert(deliveries).values(rows).onConflictDoNothing().returning({ id: deliveries.id })
        : [];
      // Nobody left to send to (everyone deactivated since): done, with an empty log.
      await tx
        .update(reminders)
        .set({ status: rows.length ? "sending" : "sent" })
        .where(eq(reminders.id, r.id));
      return inserted.map((d) => d.id);
    });
    if (ids === null) return count;
    count++;
    if (ids.length) await enqueue(ids);
  }
}

// A reminder is sent once none of its deliveries is still in flight.
async function finishReminder(reminderId: string) {
  await ownerDb
    .update(reminders)
    .set({ status: "sent" })
    .where(
      and(
        eq(reminders.id, reminderId),
        eq(reminders.status, "sending"),
        sql`not exists (select 1 from ${deliveries} where ${deliveries.reminderId} = ${reminderId} and ${deliveries.status} in ('queued','sending'))`,
      ),
    );
}

export async function deliverOne(deliveryId: string, send: typeof sendMail = sendMail) {
  const [d] = await ownerDb
    .update(deliveries)
    .set({ status: "sending", attempts: sql`${deliveries.attempts} + 1` })
    .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "queued")))
    .returning();
  if (!d) return "skipped"; // sent, failed, or another worker has it

  const [r] = await ownerDb
    .select({ reminder: reminders, creatorEmail: user.email })
    .from(reminders)
    .innerJoin(user, eq(user.id, reminders.createdBy))
    .where(eq(reminders.id, d.reminderId));
  try {
    await send({
      to: d.email,
      subject: r.reminder.title,
      text: r.reminder.description || r.reminder.title,
      links: [
        ...r.reminder.links,
        { label: "Open in NotifyHub", url: `${process.env.BETTER_AUTH_URL}/reminders/${r.reminder.id}` },
      ],
      fromName: `${r.reminder.senderName} via NotifyHub`,
      replyTo: r.creatorEmail,
    });
  } catch (e) {
    const final = d.attempts >= MAX_ATTEMPTS;
    await ownerDb
      .update(deliveries)
      .set({ status: final ? "failed" : "queued", lastError: String((e as Error).message ?? e).slice(0, 500) })
      .where(eq(deliveries.id, d.id));
    if (final) {
      await finishReminder(d.reminderId);
      return "failed";
    }
    throw e; // pg-boss retries with backoff
  }
  await ownerDb.update(deliveries).set({ status: "sent", sentAt: new Date(), lastError: null }).where(eq(deliveries.id, d.id));
  await finishReminder(d.reminderId);
  return "sent";
}

// Each tick: fail rows stuck in `sending`, and return queued rows that lost
// their job (e.g. enqueue failed after dispatch committed) for re-enqueueing.
export async function sweep() {
  const stuck = await ownerDb
    .update(deliveries)
    .set({ status: "failed", lastError: "Outcome unknown: the worker stopped mid-send. Not resent, to avoid a duplicate." })
    .where(and(eq(deliveries.status, "sending"), lt(deliveries.updatedAt, new Date(Date.now() - STUCK_AFTER_MS))))
    .returning({ reminderId: deliveries.reminderId });
  for (const id of new Set(stuck.map((s) => s.reminderId))) await finishReminder(id);

  const orphans = await ownerDb
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(and(eq(deliveries.status, "queued"), lt(deliveries.updatedAt, new Date(Date.now() - 2 * 60_000))));
  return orphans.map((o) => o.id);
}

