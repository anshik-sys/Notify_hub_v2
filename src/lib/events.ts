import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { type EventAnswer, eventResponses, reminders, reminderTargets, user } from "@/db/schema";
import { ANSWER_LABEL, answerOpen, eventEnd, eventWhen, isAnswer, readRsvp } from "./invite";
import { invitedSql } from "./reminders";
import { addNotifications, planTell, sendTell } from "./notifications";
import { resolveRecipients, type Tx } from "./recipients";

// PRD 14.3 replies. The guests are the event's targets resolved now, minus
// the organiser (EV8: they count as Yes and never answer). One answer per
// guest for the whole series (RS6).

async function guestsOf(tx: Tx, companyId: string, r: { id: string; createdBy: string }) {
  const targets = await tx.select({ kind: reminderTargets.kind, ref: reminderTargets.ref }).from(reminderTargets).where(eq(reminderTargets.reminderId, r.id));
  return (await resolveRecipients(tx, companyId, targets)).users.filter((u) => u.id !== r.createdBy);
}

// A guest answers (RS1, RS3): from the event's page, the calendar card, a
// Slack button or an emailed link. actorId: who the audit log names when
// there's no session (Slack, email links). Returns an error string or null.
export async function respond(companyId: string, userId: string, eventId: string, answer: unknown, actorId?: string, now = new Date()) {
  if (!isAnswer(answer)) return "Pick Yes, No or Maybe.";
  const result = await withTenant(
    companyId,
    async (tx) => {
      const [r] = await tx
        .select()
        .from(reminders)
        .where(and(eq(reminders.id, eventId), isNull(reminders.deletedAt)));
      if (!r?.isEvent) return "Event not found.";
      if (r.createdBy === userId) return "You’re the organiser, so you’re going.";
      // Not while it waits for approval, nor once rejected or cancelled (IN5).
      if (!["scheduled", "paused", "sent"].includes(r.status)) return "This event isn’t scheduled.";
      if (!answerOpen(r, now)) return "This event has ended.";
      if (!(await guestsOf(tx, companyId, r)).some((g) => g.id === userId)) return "You’re not invited to this event.";
      const [before] = await tx
        .select({ answer: eventResponses.answer })
        .from(eventResponses)
        .where(and(eq(eventResponses.reminderId, eventId), eq(eventResponses.userId, userId)));
      if (before?.answer === answer) return { tell: null }; // a repeated click: nothing new to tell
      await tx
        .insert(eventResponses)
        .values({ companyId, reminderId: eventId, userId, answer })
        .onConflictDoUpdate({ target: [eventResponses.reminderId, eventResponses.userId], set: { answer, updatedAt: now } });
      // RS7: the organiser hears about each answer in the app; email and Slack only if they turned them on.
      const [guest] = await tx.select({ name: user.name }).from(user).where(eq(user.id, userId));
      const text = `${guest?.name ?? "A guest"} answered ${ANSWER_LABEL[answer]}${before ? " (was " + ANSWER_LABEL[before.answer] + ")" : ""}`;
      await addNotifications(tx, [{ companyId, userId: r.createdBy, kind: "rsvp", reminderId: eventId, actorId: userId, text }]);
      const tell = await planTell(tx, companyId, [r.createdBy], "rsvp", {
        subject: `${guest?.name ?? "A guest"}: ${ANSWER_LABEL[answer]} to ${r.title}`,
        text: `${text} to "${r.title}" (${eventWhen(r)}).`,
        link: { label: "See who’s coming", url: `${process.env.BETTER_AUTH_URL}/reminders/${eventId}` },
      });
      return { tell };
    },
    actorId,
  );
  if (typeof result === "string") return result;
  if (result.tell) await sendTell(result.tell);
  return null;
}

export type Guest = { id: string; name: string; answer: EventAnswer | null; organiser?: boolean };

// RS4 / RS5: everyone's answer, organiser first (as Yes), then by name. The
// page decides who sees names (the organiser and full access) and who only
// sees the totals and their own answer.
export async function eventGuests(companyId: string, r: { id: string; createdBy: string; creatorName: string }) {
  const { guests, answers, names } = await withTenant(companyId, async (tx) => {
    const guests = await guestsOf(tx, companyId, r);
    const ids = guests.map((g) => g.id);
    const answers = ids.length
      ? await tx
          .select({ userId: eventResponses.userId, answer: eventResponses.answer })
          .from(eventResponses)
          .where(and(eq(eventResponses.reminderId, r.id), inArray(eventResponses.userId, ids)))
      : [];
    const names = ids.length ? await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)) : [];
    return { guests, answers, names };
  });
  const answerOf = new Map(answers.map((a) => [a.userId, a.answer]));
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const list: Guest[] = [
    { id: r.createdBy, name: r.creatorName, answer: "yes", organiser: true },
    ...guests.map((g) => ({ id: g.id, name: nameOf.get(g.id) ?? g.email, answer: answerOf.get(g.id) ?? null })).sort((a, b) => a.name.localeCompare(b.name)),
  ];
  const count = (a: EventAnswer | null) => list.filter((g) => g.answer === a).length;
  return { list, counts: { yes: count("yes"), maybe: count("maybe"), no: count("no"), none: count(null) } };
}

// --- The emailed reply link (RS2) ------------------------------------------------
// The token names the guest; the page asks for a click before saving.

export async function rsvpTarget(token: string) {
  const t = readRsvp(token);
  if (!t) return null;
  const [row] = await withTenant(
    t.companyId,
    (tx) =>
      tx
        .select({ event: reminders, answer: eventResponses.answer, name: user.name, email: user.email })
        .from(reminders)
        .innerJoin(user, eq(user.id, t.userId))
        .leftJoin(eventResponses, and(eq(eventResponses.reminderId, reminders.id), eq(eventResponses.userId, t.userId)))
        .where(and(eq(reminders.id, t.eventId), eq(reminders.isEvent, true), isNull(reminders.deletedAt))),
    t.userId,
  );
  return row ? { title: row.event.title, when: eventWhen(row.event), location: row.event.location, answer: row.answer, name: row.name, email: row.email } : null;
}

export async function respondByToken(token: string, answer: unknown) {
  const t = readRsvp(token);
  if (!t) return "This link isn’t valid.";
  return respond(t.companyId, t.userId, t.eventId, answer, t.userId);
}

// --- The Events page (section 12) ----------------------------------------------------
// Events I organise or am a guest of (EP2, EP9: not everything I could open).
// Guests only see scheduled ones (invitedSql, VS1); my own waiting or rejected
// ones show with a badge (EP7). Cancelled and deleted never (EP8).
// Upcoming: not ended, soonest first; a series is one row at its next date.
// Past: ended, latest first, paged.

export const EVENTS_PAGE = 25;
const end = sql`${reminders.sendAt} + make_interval(mins => coalesce(${reminders.durationMinutes}, 60))`;

export async function myEvents(companyId: string, userId: string, opts: { past: boolean; page?: number; limit?: number }, now = new Date()) {
  const mine = or(eq(reminders.createdBy, userId), invitedSql(userId));
  const upcoming = or(
    inArray(reminders.status, ["pending_approval", "rejected", "scheduled", "paused"]),
    and(eq(reminders.status, "sent"), isNull(reminders.recurrence), sql`${end} > ${now}`),
  );
  const ended = and(eq(reminders.status, "sent"), or(sql`${reminders.recurrence} is not null`, sql`${end} <= ${now}`));
  const where = and(eq(reminders.isEvent, true), isNull(reminders.deletedAt), mine, opts.past ? ended : upcoming);
  const limit = opts.limit ?? EVENTS_PAGE;
  const page = Math.max(1, opts.page ?? 1);
  return withTenant(companyId, async (tx) => {
    const rows = await tx
      .select({
        id: reminders.id,
        title: reminders.title,
        status: reminders.status,
        sendAt: reminders.sendAt,
        durationMinutes: reminders.durationMinutes,
        allDay: reminders.allDay,
        location: reminders.location,
        recurrence: reminders.recurrence,
        anchorLocal: reminders.anchorLocal,
        timeZone: reminders.timeZone,
        createdBy: reminders.createdBy,
        organiser: user.name,
        answer: sql<EventAnswer | null>`(select er.answer from event_responses er where er.reminder_id = "reminders"."id" and er.user_id = ${userId})`,
        going: sql<Record<EventAnswer, number>>`(select json_build_object('yes', 1 + count(*) filter (where er.answer = 'yes'),
          'maybe', count(*) filter (where er.answer = 'maybe'), 'no', count(*) filter (where er.answer = 'no'))
          from event_responses er where er.reminder_id = "reminders"."id")`,
      })
      .from(reminders)
      .innerJoin(user, eq(user.id, reminders.createdBy))
      .where(where)
      .orderBy(opts.past ? desc(reminders.sendAt) : asc(reminders.sendAt))
      .limit(limit)
      .offset((page - 1) * limit);
    const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(reminders).where(where);
    return {
      total,
      rows: rows.map((r) => ({
        ...r,
        when: eventWhen(r),
        organising: r.createdBy === userId,
        now: r.sendAt <= now && eventEnd(r) > now, // EP2: running
        open: answerOpen(r, now),
      })),
    };
  });
}
