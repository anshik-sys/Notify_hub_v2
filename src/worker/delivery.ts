import { type AnyColumn, and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { attachments, companies, companyLogos, deliveries, emailSuppressions, notifications, reminderOccurrences, reminders, reminderTargets, slackInstallations, taskAssignments, user, userRoles } from "@/db/schema";
import { COMPANY_ADMIN_ROLE_ID } from "@/lib/permissions";
import { emailFiles } from "@/lib/attachments";
import { brandFor, renderInviteEmail, renderReminderEmail, renderSoonEmail } from "@/lib/email-render";
import { dueNotices, eventIcs, eventWhen, noticeStart, rsvpUrl, startsIn } from "@/lib/invite";
import { eventResponses } from "@/db/schema";
import { getBlob } from "@/lib/storage";
import { decrypt } from "@/lib/crypto";
import { inviteMessage, lookupByEmail, openDm, postMessage, reminderMessage, SlackError, soonMessage, uploadFile } from "@/lib/slack";
import { between, nextAfter } from "@/lib/recurrence";
import { formatInZone, toLocalInput } from "@/lib/time";
import { sendMail } from "@/lib/mail";
import { addNotifications, planTell, sendTell } from "@/lib/notifications";
import { resolveRecipients } from "@/lib/recipients";
import { unsubscribeUrls } from "@/lib/unsubscribe";
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

// PRD 9.2: a suspended company's sends wait until it's unsuspended. Rows
// already queued when it was suspended may still go out.
const notSuspended = (companyId: AnyColumn) => sql`not exists (select 1 from companies c where c.id = ${companyId} and c.suspended_at is not null)`;
const STUCK_AFTER_MS = 10 * 60_000;

type Reminder = typeof reminders.$inferSelect;
type Tx = Parameters<Parameters<typeof ownerDb.transaction>[0]>[0];

function occurrenceRow(r: Reminder, occursAt: Date, status: "sending" | "missed" | "skipped") {
  return {
    companyId: r.companyId,
    reminderId: r.id,
    occursAt,
    status,
    // Tasks: each occurrence is due the same time after it's sent.
    dueAt: r.isTask && r.dueAfterMinutes ? new Date(occursAt.getTime() + r.dueAfterMinutes * 60_000) : null,
  };
}

// One occurrence at occursAt: resolve recipients now, one delivery per
// (channel, address), task assignments. Returns the new delivery ids, or null
// if that occurrence already exists (skipped, or a duplicate run).
async function createOccurrence(tx: Tx, r: Reminder, occursAt: Date) {
  const snapshot = { title: r.title, description: r.description, links: r.links, senderName: r.senderName };
  const [occ] = await tx
    .insert(reminderOccurrences)
    .values({ ...occurrenceRow(r, occursAt, "sending"), snapshot })
    .onConflictDoNothing()
    .returning({ id: reminderOccurrences.id });
  if (!occ) return null;
  // An event's date coming round sends nothing itself (its invites and
  // "starts soon" notices are separate, PRD 14.3): it's recorded as happened,
  // so the calendar shows it as past and a series moves on.
  if (r.isEvent) {
    await tx.update(reminderOccurrences).set({ status: "sent" }).where(eq(reminderOccurrences.id, occ.id));
    return [];
  }
  const targets = await tx
    .select({ kind: reminderTargets.kind, ref: reminderTargets.ref })
    .from(reminderTargets)
    .where(eq(reminderTargets.reminderId, r.id));
  const { users, external: typed } = await resolveRecipients(tx, r.companyId, targets);
  // Outside addresses that unsubscribed from this company get nothing (PRD 7.1).
  const gone = typed.length
    ? await tx
        .select({ email: emailSuppressions.email })
        .from(emailSuppressions)
        .where(and(eq(emailSuppressions.companyId, r.companyId), inArray(emailSuppressions.email, typed)))
    : [];
  const external = typed.filter((e) => !gone.some((g) => g.email === e));
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
      ...targets.filter((t) => t.kind === "slack_channel").map((t) => ({ channel: "slack" as const, address: t.ref!, userId: null })),
    );
  }
  // The notification centre: once per person, whatever the channels.
  await addNotifications(
    tx,
    users.map((u) => ({
      companyId: r.companyId,
      userId: u.id,
      kind: r.isTask ? "task" : "reminder",
      reminderId: r.id,
      text: r.isTask ? `${r.senderName} assigned you a task` : `${r.senderName} sent you a reminder`,
      dedupeKey: `occ:${occ.id}`,
    })),
  );
  // A task's assignees: every internal recipient, once, whatever the channels.
  if (r.isTask && users.length)
    await tx
      .insert(taskAssignments)
      .values(users.map((u) => ({ companyId: r.companyId, reminderId: r.id, occurrenceId: occ.id, userId: u.id })))
      .onConflictDoNothing();
  const deliveryRows = rows.map((x) => ({ ...x, companyId: r.companyId, reminderId: r.id, occurrenceId: occ.id }));
  if (!deliveryRows.length) {
    // Nobody left to send to (everyone deactivated since): done, with an empty log.
    await tx.update(reminderOccurrences).set({ status: "sent" }).where(eq(reminderOccurrences.id, occ.id));
    return [];
  }
  return (await tx.insert(deliveries).values(deliveryRows).onConflictDoNothing().returning({ id: deliveries.id })).map((d) => d.id);
}

// "Send now" on a repeating reminder: one extra occurrence at send_now_at.
// The claim clears the field in the same transaction (SKIP LOCKED keeps two
// workers apart; the occurrence's unique key makes a repeat harmless). The
// schedule (send_at) and status are untouched.
export async function dispatchManual(enqueue: (deliveryIds: string[]) => Promise<void>, onlyCompany?: string) {
  let count = 0;
  for (;;) {
    const ids = await ownerDb.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(reminders)
        .where(and(sql`${reminders.sendNowAt} is not null`, notSuspended(reminders.companyId), onlyCompany ? eq(reminders.companyId, onlyCompany) : undefined))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!r) return null;
      await tx.update(reminders).set({ sendNowAt: null }).where(eq(reminders.id, r.id));
      // Cancelled (or otherwise stopped) since the click: drop the request.
      if (r.status !== "scheduled" && r.status !== "paused") return [];
      return (await createOccurrence(tx, r, r.sendNowAt!)) ?? [];
    });
    if (ids === null) return count;
    count++;
    if (ids.length) await enqueue(ids);
  }
}

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
            notSuspended(reminders.companyId),
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
      if (missed.length)
        await tx
          .insert(reminderOccurrences)
          .values(missed.map((at) => occurrenceRow(r, at, "missed")))
          .onConflictDoNothing();
      // "Only the next one" replaced this date (detachOccurrence) and was
      // approved after it was made: the copy sends instead. Still waiting,
      // rejected or deleted: the series sends as usual.
      const [replaced] = await tx
        .select({ id: reminders.id })
        .from(reminders)
        .where(
          and(
            eq(reminders.replacesSeriesId, r.id),
            eq(reminders.replacesOccursAt, toSend),
            inArray(reminders.status, ["scheduled", "sending", "sent"]),
            sql`${reminders.deletedAt} is null`,
          ),
        )
        .limit(1);
      if (replaced)
        await tx.insert(reminderOccurrences).values(occurrenceRow(r, toSend, "skipped")).onConflictDoNothing();
      // null = this occurrence already exists (the user skipped it): nothing sent.
      const deliveryIds = replaced ? [] : ((await createOccurrence(tx, r, toSend)) ?? []);

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

// --- Event invites (PRD 14.3) ----------------------------------------------------
// Every scheduled event still to come: each guest, resolved now, has one
// invite per channel (IN1). Someone who joined a guest department or group
// since gets theirs on the next run (IN6); the partial unique index
// (deliveries_invite_idx) makes a repeat insert nothing (IN2). Waiting for
// approval or rejected isn't scheduled, so nothing goes (IN5). The organiser
// gets none (EV8).
// ponytail: re-resolves every upcoming event's guests on each run (every
// minute and on each wake-up); track a "guests may have changed" flag if a
// company ever holds thousands of upcoming events.
export async function dispatchInvites(enqueue: (deliveryIds: string[]) => Promise<void>, onlyCompany?: string, now = new Date()) {
  const events = await ownerDb
    .select()
    .from(reminders)
    .where(
      and(
        eq(reminders.isEvent, true),
        eq(reminders.status, "scheduled"),
        isNull(reminders.deletedAt),
        // A one-time event that hasn't ended; a scheduled series has dates to come.
        or(sql`${reminders.recurrence} is not null`, sql`${reminders.sendAt} + make_interval(mins => ${reminders.durationMinutes}) > ${now}`),
        notSuspended(reminders.companyId),
        onlyCompany ? eq(reminders.companyId, onlyCompany) : undefined,
      ),
    );
  let count = 0;
  for (const r of events) {
    const ids = await ownerDb.transaction(async (tx) => {
      const targets = await tx
        .select({ kind: reminderTargets.kind, ref: reminderTargets.ref })
        .from(reminderTargets)
        .where(eq(reminderTargets.reminderId, r.id));
      const guests = (await resolveRecipients(tx, r.companyId, targets)).users.filter((u) => u.id !== r.createdBy);
      const rows = [
        ...(r.channels.includes("email") ? guests.map((u) => ({ channel: "email" as const, address: u.email, userId: u.id })) : []),
        // Company-wide on Slack never DMs everyone (PRD 5.3), invites included.
        ...(r.channels.includes("slack") && !targets.some((t) => t.kind === "company")
          ? guests.map((u) => ({ channel: "slack" as const, address: u.id, userId: u.id }))
          : []),
      ];
      if (!rows.length) return [];
      return (
        await tx
          .insert(deliveries)
          .values(rows.map((x) => ({ ...x, kind: "invite" as const, companyId: r.companyId, reminderId: r.id })))
          .onConflictDoNothing()
          .returning({ id: deliveries.id })
      ).map((d) => d.id);
    });
    count += ids.length;
    if (ids.length) await enqueue(ids);
  }
  return count;
}

// --- "Starts soon" notices (PRD 14.3, SN1-SN6) ---------------------------------------
// Each run: for every scheduled event with notice times, the notice due now
// for each date (dueNotices), to each guest who hasn't said No, over the
// event's channels. The partial unique index deliveries_soon_idx makes it
// once per (date, minutes before, channel, guest). A skipped date, or one
// replaced by an approved "only this one" copy, gets none; cancelled, deleted
// and paused events aren't scheduled.
// ponytail: scans every scheduled series with notice times each run; add a
// "next notice at" column if that list ever gets long.
export async function dispatchSoon(enqueue: (deliveryIds: string[]) => Promise<void>, onlyCompany?: string, now = new Date()) {
  const events = await ownerDb
    .select()
    .from(reminders)
    .where(
      and(
        eq(reminders.isEvent, true),
        // A one-time all-day event is "sent" at midnight; its notices count from 09:00 (SN5).
        inArray(reminders.status, ["scheduled", "sent"]),
        isNull(reminders.deletedAt),
        sql`cardinality(${reminders.notifyBefore}) > 0`,
        or(
          sql`${reminders.recurrence} is not null`,
          sql`${reminders.sendAt} > ${now}::timestamptz - interval '10 hours' and ${reminders.sendAt} <= ${now}::timestamptz + interval '1441 minutes'`,
        ),
        notSuspended(reminders.companyId),
        onlyCompany ? eq(reminders.companyId, onlyCompany) : undefined,
      ),
    );
  let count = 0;
  for (const r of events) {
    for (const n of dueNotices(r, now)) {
      const ids = await ownerDb.transaction(async (tx) => {
        // SN6: a skipped date, or one an approved copy replaced (as dispatchDue does).
        const [gone] = await tx
          .select({ id: reminderOccurrences.id })
          .from(reminderOccurrences)
          .where(and(eq(reminderOccurrences.reminderId, r.id), eq(reminderOccurrences.occursAt, n.occursAt), eq(reminderOccurrences.status, "skipped")))
          .limit(1);
        const [replaced] = await tx
          .select({ id: reminders.id })
          .from(reminders)
          .where(
            and(
              eq(reminders.replacesSeriesId, r.id),
              eq(reminders.replacesOccursAt, n.occursAt),
              inArray(reminders.status, ["scheduled", "sending", "sent"]),
              isNull(reminders.deletedAt),
            ),
          )
          .limit(1);
        if (gone || replaced) return [];
        const targets = await tx
          .select({ kind: reminderTargets.kind, ref: reminderTargets.ref })
          .from(reminderTargets)
          .where(eq(reminderTargets.reminderId, r.id));
        const saidNo = new Set(
          (
            await tx
              .select({ userId: eventResponses.userId })
              .from(eventResponses)
              .where(and(eq(eventResponses.reminderId, r.id), eq(eventResponses.answer, "no")))
          ).map((x) => x.userId),
        );
        const guests = (await resolveRecipients(tx, r.companyId, targets)).users.filter((u) => u.id !== r.createdBy && !saidNo.has(u.id));
        const rows = [
          ...(r.channels.includes("email") ? guests.map((u) => ({ channel: "email" as const, address: u.email, userId: u.id })) : []),
          ...(r.channels.includes("slack") && !targets.some((t) => t.kind === "company")
            ? guests.map((u) => ({ channel: "slack" as const, address: u.id, userId: u.id }))
            : []),
        ];
        if (!rows.length) return [];
        return (
          await tx
            .insert(deliveries)
            .values(rows.map((x) => ({ ...x, kind: "soon" as const, occursAt: n.occursAt, beforeMinutes: n.minutes, companyId: r.companyId, reminderId: r.id })))
            .onConflictDoNothing()
            .returning({ id: deliveries.id })
        ).map((d) => d.id);
      });
      count += ids.length;
      if (ids.length) await enqueue(ids);
    }
  }
  return count;
}

const inFlight = sql`('queued','sending')`;

// An occurrence is sent once none of its deliveries is still in flight.
async function finishOccurrence(occurrenceId: string | null) {
  if (!occurrenceId) return; // an invite: no occurrence
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

async function finish(d: { occurrenceId: string | null; reminderId: string }) {
  await finishOccurrence(d.occurrenceId);
  await finishReminder(d.reminderId);
}

// A failure that retrying can't fix: fail now instead of burning attempts.
class Permanent extends Error {}
const PERMANENT_SLACK = new Set(["channel_not_found", "is_archived", "invalid_auth", "token_revoked", "account_inactive", "not_in_channel"]);

type Delivery = typeof deliveries.$inferSelect;
type Loaded = { reminder: typeof reminders.$inferSelect; creatorEmail: string; creatorName: string; dueAt: Date | null };

// The reminder's files, in upload order (metadata only; bytes on demand).
const filesOf = (reminderId: string) =>
  ownerDb
    .select({ id: attachments.id, fileName: attachments.fileName, contentType: attachments.contentType, size: attachments.size })
    .from(attachments)
    .where(eq(attachments.reminderId, reminderId))
    .orderBy(attachments.createdAt);

async function brandOf(companyId: string) {
  const [co] = await ownerDb
    .select({ name: companies.name, logoAt: companyLogos.updatedAt })
    .from(companies)
    .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id))
    .where(eq(companies.id, companyId));
  return brandFor(process.env.BETTER_AUTH_URL ?? "", companyId, co?.name ?? "", co?.logoAt ? String(co.logoAt.getTime()) : null);
}

async function sendEmail(d: Delivery, r: Loaded, send: typeof sendMail) {
  // ponytail: bytes are re-read per recipient; cache per dispatch if large
  // company-wide sends with files get slow.
  const { attached, tooBig } = await emailFiles(await filesOf(r.reminder.id), (id) => getBlob(ownerDb, id));
  const brand = await brandOf(r.reminder.companyId);
  // No user id: an outside address. Members can't unsubscribe (PRD 7.1).
  const unsub = d.userId ? null : unsubscribeUrls(r.reminder.companyId, d.address);
  const email = renderReminderEmail({
    title: r.reminder.title,
    description: r.reminder.description,
    links: r.reminder.links,
    senderName: r.reminder.senderName,
    appUrl: `${process.env.BETTER_AUTH_URL}/reminders/${r.reminder.id}`,
    due: r.reminder.isTask && r.dueAt ? `${formatInZone(r.dueAt, r.reminder.timeZone)} (${r.reminder.timeZone})` : undefined,
    tooBig,
    unsubscribeUrl: unsub?.page,
    brand,
  });
  // RFC 8058 one-click, so mail apps show their own Unsubscribe button.
  const headers = unsub && { "List-Unsubscribe": `<${unsub.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  await send({ to: d.address, ...email, replyTo: r.creatorEmail, attachments: attached, ...(headers ? { headers } : {}) });
  return {};
}

// An invite (PRD 14.3): when, where, Join, the guest's own Yes / No / Maybe
// links (RS2), the event's files (EV10) and the .ics (IN3).
async function sendInviteEmail(d: Delivery, r: Loaded, send: typeof sendMail) {
  const e = r.reminder;
  const [guest] = await ownerDb.select({ name: user.name }).from(user).where(eq(user.id, d.userId!));
  const { attached, tooBig } = await emailFiles(await filesOf(e.id), (id) => getBlob(ownerDb, id));
  const appUrl = `${process.env.BETTER_AUTH_URL}/reminders/${e.id}`;
  const when = eventWhen(e);
  const email = renderInviteEmail({
    ...e,
    links: e.links,
    when,
    answerUrls: { yes: rsvpUrl(e.companyId, e.id, d.userId!, "yes"), no: rsvpUrl(e.companyId, e.id, d.userId!, "no"), maybe: rsvpUrl(e.companyId, e.id, d.userId!, "maybe") },
    appUrl,
    tooBig,
    brand: await brandOf(e.companyId),
  });
  const ics = eventIcs(e, { organizer: { name: r.creatorName, email: r.creatorEmail }, attendee: { name: guest?.name ?? d.address, email: d.address }, url: appUrl });
  await send({
    to: d.address,
    ...email,
    replyTo: r.creatorEmail,
    attachments: [{ filename: "invite.ics", content: Buffer.from(ics), contentType: "text/calendar; charset=utf-8; method=REQUEST" }, ...attached],
  });
  return {};
}

// What a "starts soon" notice says, for the date it's about.
function soonText(d: Delivery, e: Reminder, now = new Date()) {
  const date = { ...e, sendAt: d.occursAt!, recurrence: null };
  const startsAt = noticeStart(d.occursAt!, e.allDay, e.timeZone);
  // An all-day notice goes the day before (1 day) or that morning (SN5).
  const today = toLocalInput(d.occursAt!, e.timeZone).slice(0, 10) === toLocalInput(now, e.timeZone).slice(0, 10);
  // The notice's own minutes ("in 10 minutes"), or less when it went late.
  const soonest = new Date(Math.min(startsAt.getTime(), now.getTime() + d.beforeMinutes! * 60_000));
  const headline = e.allDay ? (today ? "Today" : "Tomorrow") : `Starts ${startsIn(soonest, now)}`;
  return { headline, when: eventWhen(date) };
}

async function sendSoonEmail(d: Delivery, r: Loaded, send: typeof sendMail) {
  const e = r.reminder;
  const email = renderSoonEmail({
    ...e,
    ...soonText(d, e),
    appUrl: `${process.env.BETTER_AUTH_URL}/reminders/${e.id}`,
    brand: await brandOf(e.companyId),
  });
  await send({ to: d.address, ...email, replyTo: r.creatorEmail });
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
  let dm = false;
  if (d.userId) {
    const [u] = await ownerDb.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, d.userId));
    const slackUser = await lookupByEmail(token, u.email, f);
    if (slackUser) {
      channel = await openDm(token, slackUser, f);
      dm = true;
    }
    else if (inst.fallbackChannelId) {
      channel = inst.fallbackChannelId;
      note = `For ${u.name}: they have no Slack account under ${u.email}, so this is posted here.`;
    } else throw new Permanent(`No Slack account for ${u.email}, and no fallback channel is set.`);
  }
  const appUrl = `${process.env.BETTER_AUTH_URL}/reminders/${r.reminder.id}`;
  const msg =
    d.kind === "invite"
      ? inviteMessage({ ...r.reminder, when: eventWhen(r.reminder), eventId: r.reminder.id, appUrl, note })
      : d.kind === "soon"
        ? soonMessage({ ...r.reminder, ...soonText(d, r.reminder), appUrl, note })
        : reminderMessage({
          title: r.reminder.title,
          description: r.reminder.description,
          links: r.reminder.links,
          appUrl,
          due: r.reminder.isTask && r.dueAt ? `${formatInZone(r.dueAt, r.reminder.timeZone)} (${r.reminder.timeZone})` : undefined,
          note,
          // Buttons on tasks; snooze only in a real DM (a fallback-channel post is shared).
          task: r.reminder.isTask && d.occurrenceId ? { occurrenceId: d.occurrenceId, dm } : undefined,
        });
  let posted: { channel: string; ts: string };
  try {
    posted = await postMessage(token, channel, msg.text, msg.blocks, f);
  } catch (e) {
    if (e instanceof SlackError && PERMANENT_SLACK.has(e.code)) throw new Permanent(`Slack: ${e.code}`);
    throw e;
  }
  // Files go into the message's thread. The message is already posted, so a
  // failed upload is noted on the delivery, never retried (that would post the
  // message again).
  const notes = note ? [`Sent to #${inst.fallbackChannelName ?? "fallback"}: not on Slack`] : [];
  let failed = 0;
  let scopeMissing = false;
  let notInChannel = false;
  // Files go with the message and the invite, not with "starts soon".
  for (const file of d.kind === "soon" ? [] : await filesOf(r.reminder.id)) {
    try {
      const data = await getBlob(ownerDb, file.id);
      if (data) await uploadFile(token, { channel: posted.channel, threadTs: posted.ts, filename: file.fileName, data }, f);
    } catch (e) {
      console.error("Slack file upload failed", file.id, e);
      if (e instanceof SlackError && e.code === "missing_scope") scopeMissing = true;
      if (e instanceof SlackError && e.code === "not_in_channel") notInChannel = true;
      failed++;
    }
  }
  if (scopeMissing) notes.push("Files not sent: reconnect Slack to allow file uploads");
  else if (notInChannel) notes.push("Files not sent: invite the Slack app to the channel, or reconnect Slack");
  else if (failed) notes.push(`${failed} file${failed === 1 ? "" : "s"} failed to upload`);
  return { slackChannel: posted.channel, slackTs: posted.ts, lastError: notes.join("; ") || null };
}

// slackFetch is for tests (a fake Slack); production uses the real fetch.
// --- Daily email limit (PRD 7.1) ---------------------------------------------
// Every company sends from the same domain, so one company's burst can hurt
// delivery for all. Reminder emails per rolling 24 hours are capped per
// company (companies.daily_email_limit). Over it, a delivery stays queued
// with a "Held" note and no attempt used; sweep re-enqueues it every couple of
// minutes until there's room. Nothing is dropped and nothing sends twice.
// ponytail: a soft cap; parallel sends (10 per worker) can overshoot by that
// many. Count under a per-company lock if it ever needs to be exact.
// Other mail (invites, approvals, follow-ups) isn't counted: it goes to members.
async function emailCapReached(companyId: string) {
  const { rows } = await ownerDb.execute<{ full: boolean; cap: number }>(sql`
    select c.daily_email_limit as cap,
           (select count(*) from deliveries d
             where d.company_id = c.id and d.channel = 'email'
               and (d.status = 'sending' or (d.status = 'sent' and d.sent_at > now() - interval '24 hours'))) >= c.daily_email_limit as full
      from companies c where c.id = ${companyId}`);
  return rows[0]?.full ? rows[0].cap : null;
}

const companyAdmins = (companyId: string) =>
  ownerDb
    .select({ id: user.id, email: user.email })
    .from(userRoles)
    .innerJoin(user, eq(user.id, userRoles.userId))
    .where(and(eq(userRoles.companyId, companyId), eq(userRoles.roleId, COMPANY_ADMIN_ROLE_ID), sql`${user.deactivatedAt} is null`));

// Company Admins hear about it once a day: in the app, and by email.
async function noticeHeld(companyId: string, reminderId: string, cap: number) {
  const day = new Date().toISOString().slice(0, 10);
  const admins = await companyAdmins(companyId);
  if (!admins.length) return;
  const text = `Daily email limit reached (${cap} in 24 hours): emails are held and go out as room frees up`;
  const fresh = await ownerDb
    .insert(notifications)
    .values(admins.map((a) => ({ companyId, userId: a.id, kind: "failed", reminderId, text, dedupeKey: `held:${day}` })))
    .onConflictDoNothing()
    .returning({ userId: notifications.userId });
  const tell = await planTell(ownerDb, companyId, fresh.map((f) => f.userId), "held", {
    subject: "Your company reached its daily email limit",
    text: `${text}. Nothing is lost: each held email is sent automatically once the last 24 hours drop below ${cap}. To raise the limit, contact the NotifyHub team.`,
    link: { label: "Open the reminder", url: `${process.env.BETTER_AUTH_URL}/reminders/${reminderId}` },
  });
  await sendTell(tell);
}

// SN6: a queued "starts soon" notice that no longer applies (the event was
// cancelled, deleted or paused, the date skipped, or the guest said No since
// it was queued, e.g. while held by the daily limit). The reason, or null.
async function noLongerDue(d: { reminderId: string; userId: string | null; occursAt: Date | null }) {
  const [r] = await ownerDb.select({ status: reminders.status, deletedAt: reminders.deletedAt }).from(reminders).where(eq(reminders.id, d.reminderId));
  if (!r || r.deletedAt) return "Not sent: the event was deleted.";
  if (r.status !== "scheduled" && r.status !== "sent") return "Not sent: the event was cancelled or paused.";
  const [skipped] = await ownerDb
    .select({ id: reminderOccurrences.id })
    .from(reminderOccurrences)
    .where(and(eq(reminderOccurrences.reminderId, d.reminderId), eq(reminderOccurrences.occursAt, d.occursAt!), eq(reminderOccurrences.status, "skipped")));
  if (skipped) return "Not sent: that date was skipped.";
  const [no] = d.userId
    ? await ownerDb
        .select({ answer: eventResponses.answer })
        .from(eventResponses)
        .where(and(eq(eventResponses.reminderId, d.reminderId), eq(eventResponses.userId, d.userId), eq(eventResponses.answer, "no")))
    : [];
  return no ? "Not sent: they said No." : null;
}

export async function deliverOne(deliveryId: string, send: typeof sendMail = sendMail, slackFetch?: typeof fetch) {
  const [pending] = await ownerDb
    .select({
      companyId: deliveries.companyId,
      reminderId: deliveries.reminderId,
      channel: deliveries.channel,
      kind: deliveries.kind,
      userId: deliveries.userId,
      occursAt: deliveries.occursAt,
    })
    .from(deliveries)
    .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "queued")));
  // Checked before the daily limit, so a held notice that stopped applying never waits for room.
  const dropped = pending?.kind === "soon" ? await noLongerDue(pending) : null;
  if (dropped) {
    const [row] = await ownerDb
      .update(deliveries)
      .set({ status: "dropped", lastError: dropped })
      .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "queued")))
      .returning({ id: deliveries.id });
    return row ? "dropped" : "skipped";
  }
  if (pending?.channel === "email") {
    const cap = await emailCapReached(pending.companyId);
    if (cap !== null) {
      await ownerDb
        .update(deliveries)
        .set({ lastError: `Held: the company's daily email limit (${cap}) is reached. It goes out as room frees up.`, updatedAt: new Date() })
        .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "queued")));
      await noticeHeld(pending.companyId, pending.reminderId, cap);
      return "held";
    }
  }

  const [d] = await ownerDb
    .update(deliveries)
    .set({ status: "sending", attempts: sql`${deliveries.attempts} + 1` })
    .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "queued")))
    .returning();
  if (!d) return "skipped"; // sent, failed, or another worker has it

  const [loaded] = await ownerDb
    .select({ reminder: reminders, creatorEmail: user.email, creatorName: user.name, dueAt: reminderOccurrences.dueAt, snapshot: reminderOccurrences.snapshot })
    .from(reminders)
    .innerJoin(user, eq(user.id, reminders.createdBy))
    .leftJoin(reminderOccurrences, sql`${reminderOccurrences.id} = ${d.occurrenceId}`)
    .where(eq(reminders.id, d.reminderId));
  // Send what the occurrence recorded, even if the reminder was edited since.
  // An invite has no occurrence: it's the event as it is now.
  const r = { ...loaded, reminder: { ...loaded.reminder, ...loaded.snapshot } };
  let result: { slackChannel?: string; slackTs?: string; lastError?: string | null };
  try {
    result =
      d.channel === "slack"
        ? await sendSlack(d, r, slackFetch)
        : d.kind === "invite"
          ? await sendInviteEmail(d, r, send)
          : d.kind === "soon"
            ? await sendSoonEmail(d, r, send)
            : await sendEmail(d, r, send);
  } catch (e) {
    const final = e instanceof Permanent || d.attempts >= MAX_ATTEMPTS;
    await ownerDb
      .update(deliveries)
      .set({ status: final ? "failed" : "queued", lastError: String((e as Error).message ?? e).slice(0, 500) })
      .where(eq(deliveries.id, d.id));
    if (final) {
      await notifyFailed(d);
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

// Tells the creator and the Company Admins, once per occurrence however many
// deliveries failed.
// Once per occurrence (the dedupe key): in the app, plus email (on by
// default) or Slack (off) as each person chose.
async function notifyFailed(d: { companyId: string; reminderId: string; occurrenceId: string | null; kind: string }) {
  const [r] = await ownerDb.select({ createdBy: reminders.createdBy, title: reminders.title }).from(reminders).where(eq(reminders.id, d.reminderId));
  if (!r) return;
  const people = new Set([r.createdBy, ...(await companyAdmins(d.companyId)).map((a) => a.id)]);
  const text = { reminder: "Some deliveries failed", invite: "Some invites failed", soon: "Some “starts soon” notices failed" }[d.kind] ?? "Some deliveries failed";
  try {
    const fresh = await ownerDb
      .insert(notifications)
      .values([...people].map((userId) => ({ companyId: d.companyId, userId, kind: "failed" as const, reminderId: d.reminderId, text, dedupeKey: `failed:${d.occurrenceId ?? `${d.kind}:${d.reminderId}`}` })))
      .onConflictDoNothing()
      .returning({ userId: notifications.userId });
    const tell = await planTell(ownerDb, d.companyId, fresh.map((f) => f.userId), "failed", {
      subject: `Delivery failed: ${r.title}`,
      text: `${text} for "${r.title}". The reminder's page shows who didn't get it and why.`,
      link: { label: "Open the reminder", url: `${process.env.BETTER_AUTH_URL}/reminders/${d.reminderId}` },
    });
    await sendTell(tell);
  } catch (e) {
    console.error("failed-delivery notification", e);
  }
}

// Each tick: fail rows stuck in `sending`, and return queued rows that lost
// their job (e.g. enqueue failed after dispatch committed) for re-enqueueing.
export async function sweep() {
  const stuck = await ownerDb
    .update(deliveries)
    .set({ status: "failed", lastError: "Outcome unknown: the worker stopped mid-send. Not resent, to avoid a duplicate." })
    .where(and(eq(deliveries.status, "sending"), lt(deliveries.updatedAt, new Date(Date.now() - STUCK_AFTER_MS))))
    .returning({ companyId: deliveries.companyId, reminderId: deliveries.reminderId, occurrenceId: deliveries.occurrenceId, kind: deliveries.kind });
  for (const d of stuck) {
    await notifyFailed(d);
    await finish(d);
  }

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
      where (${onlyCompany ?? null}::uuid is null or c.id = ${onlyCompany ?? null}::uuid) and c.suspended_at is null
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

// A task DM to one assignee, with the Mark done / Snooze buttons (follow-ups
// and snoozes). No Slack connection or account: skipped, logged; no
// fallback-channel noise for these.
async function taskDm(assignmentId: string, prefix: string, f?: typeof fetch) {
  const [x] = await ownerDb
    .select({ a: taskAssignments, r: reminders, dueAt: reminderOccurrences.dueAt, email: user.email, inst: slackInstallations })
    .from(taskAssignments)
    .innerJoin(reminders, eq(reminders.id, taskAssignments.reminderId))
    .innerJoin(reminderOccurrences, eq(reminderOccurrences.id, taskAssignments.occurrenceId))
    .innerJoin(user, eq(user.id, taskAssignments.userId))
    .leftJoin(slackInstallations, eq(slackInstallations.companyId, taskAssignments.companyId))
    .where(eq(taskAssignments.id, assignmentId));
  if (!x?.inst) return "no-slack";
  const token = decrypt(x.inst.botTokenEnc);
  const slackUser = await lookupByEmail(token, x.email, f);
  if (!slackUser) return "not-on-slack";
  const msg = reminderMessage({
    title: x.r.title,
    description: x.r.description,
    links: x.r.links,
    appUrl: `${process.env.BETTER_AUTH_URL}/reminders/${x.r.id}`,
    due: x.dueAt ? `${formatInZone(x.dueAt, x.r.timeZone)} (${x.r.timeZone})` : undefined,
    prefix,
    task: { occurrenceId: x.a.occurrenceId, dm: true },
  });
  await postMessage(token, await openDm(token, slackUser, f), `${prefix}: ${msg.text}`, msg.blocks, f);
  return "sent";
}

// Sends one assignment's follow-up over the task's channels: email first (a
// failure throws, so pg-boss retries before Slack is tried), then a Slack DM
// whose failure is only logged (so it never causes a second email).
export async function followUpOne(assignmentId: string, send: typeof sendMail = sendMail, slackFetch?: typeof fetch) {
  const [x] = await ownerDb
    .select({ a: taskAssignments, r: reminders, dueAt: reminderOccurrences.dueAt, email: user.email })
    .from(taskAssignments)
    .innerJoin(reminders, eq(reminders.id, taskAssignments.reminderId))
    .innerJoin(reminderOccurrences, eq(reminderOccurrences.id, taskAssignments.occurrenceId))
    .innerJoin(user, eq(user.id, taskAssignments.userId))
    .where(eq(taskAssignments.id, assignmentId));
  // Marked done (or cancelled) between the claim and now: nothing to nag about.
  if (!x || x.a.doneAt || x.r.status === "cancelled" || !x.dueAt) return "skipped";
  const due = `${formatInZone(x.dueAt, x.r.timeZone)} (${x.r.timeZone})`;
  if (x.r.channels.includes("email")) {
    const [creator] = await ownerDb.select({ email: user.email }).from(user).where(eq(user.id, x.r.createdBy));
    await send({
      to: x.email,
      subject: `Overdue: ${x.r.title}`,
      text: `This task was due ${due} and isn't marked done yet. You'll get this reminder daily until it is.`,
      links: [{ label: "Mark it done in NotifyHub", url: `${process.env.BETTER_AUTH_URL}/reminders/${x.r.id}` }],
      fromName: `${x.r.senderName} via NotifyHub`,
      replyTo: creator?.email,
    });
  }
  if (x.r.channels.includes("slack"))
    await taskDm(assignmentId, `Overdue: this was due ${due} and isn't marked done yet`, slackFetch).catch((e) =>
      console.error("Slack follow-up failed", assignmentId, e),
    );
  return "sent";
}

// --- Slack snooze -------------------------------------------------------------------
// "Snooze" set snoozed_until; once it passes, the next tick claims it (clears
// it in the same UPDATE, so it's sent at most once) and re-sends the DM.
export async function claimSnoozes(now = new Date(), onlyCompany?: string) {
  const rows = await ownerDb
    .update(taskAssignments)
    .set({ snoozedUntil: null })
    .where(
      and(
        lte(taskAssignments.snoozedUntil, now),
        sql`${taskAssignments.doneAt} is null`,
        notSuspended(taskAssignments.companyId),
        onlyCompany ? eq(taskAssignments.companyId, onlyCompany) : undefined,
      ),
    )
    .returning({ id: taskAssignments.id });
  return rows.map((r) => r.id);
}

export const snoozeOne = (assignmentId: string, slackFetch?: typeof fetch) =>
  taskDm(assignmentId, "Snoozed reminder", slackFetch);
