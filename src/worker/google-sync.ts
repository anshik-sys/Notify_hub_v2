import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { companies, googleCalendarEntries, googleCalendars, notifications, reminders, user } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { createCalendar, deleteEvent, GoogleError, googleEvent, googleEventId, hashOf, putEvent, refreshAccess, teardown } from "@/lib/google";
import { exdatesOf } from "./delivery";
import { ownerDb } from "./db";

// Section 13: keep each connected person's "NotifyHub" Google calendar equal
// to what NotifyHub would show them. Compare, don't hook (like change notices):
// every run works out the entries they should have, and writes to Google only
// the ones whose content changed, plus deletes for the ones that left. So any
// change in NotifyHub (edit, drag, cancel, a new reminder, joining a
// department, saying No) shows within a minute (GC16), and nothing is written
// twice.
// ponytail: one query per connected person per minute; queue only people
// touched by a change if connections grow into the thousands.

type Conn = typeof googleCalendars.$inferSelect;
const DAY = 86_400_000;

// Every connection worth a run: active, in a company that isn't suspended.
export async function googleSyncTargets() {
  const rows = await ownerDb
    .select({ userId: googleCalendars.userId })
    .from(googleCalendars)
    .innerJoin(companies, eq(companies.id, googleCalendars.companyId))
    .where(and(eq(googleCalendars.status, "active"), isNull(companies.suspendedAt)));
  return rows.map((r) => r.userId);
}

// A usable access token, refreshing (and saving) it when it's about to expire.
async function accessFor(c: Conn, f: typeof fetch, now: Date) {
  if (c.accessTokenEnc && c.accessExpiresAt && c.accessExpiresAt.getTime() > now.getTime() + 60_000) return decrypt(c.accessTokenEnc);
  const t = await refreshAccess(decrypt(c.refreshTokenEnc), f, now);
  await ownerDb
    .update(googleCalendars)
    .set({ accessTokenEnc: encrypt(t.accessToken), accessExpiresAt: t.expiresAt })
    .where(eq(googleCalendars.userId, c.userId));
  return t.accessToken;
}

// GC9, GC10, GC11, GC15: what I created or what's addressed to me (an event or
// task I'm invited to, or anything sent to me: the app's own rule for what I
// can open), scheduled, paused or sent, from 30 days back to a year ahead
// (series still running), minus events I said No to. Explicit company filter:
// this connection bypasses RLS.
// ponytail: the "addressed to me" rule is the SQL twin of invitedSql / sentToMe
// (src/lib/reminders.ts, views.ts), which the worker can't import; change them together.
async function wanted(companyId: string, userId: string, now: Date) {
  return ownerDb
    .select()
    .from(reminders)
    .where(
      and(
        eq(reminders.companyId, companyId),
        isNull(reminders.deletedAt),
        inArray(reminders.status, ["scheduled", "paused", "sending", "sent"]),
        sql`(${reminders.createdBy} = ${userId}
          or ((${reminders.isEvent} or ${reminders.isTask}) and exists (select 1 from reminder_targets t where t.reminder_id = ${reminders.id} and (
            t.kind = 'company' or (t.kind = 'user' and t.ref = ${userId})
            or (t.kind = 'department' and t.ref in (select department_id::text from department_members where user_id = ${userId}))
            or (t.kind = 'group' and t.ref in (select group_id::text from group_members where user_id = ${userId})))))
          or exists (select 1 from deliveries d where d.reminder_id = ${reminders.id} and d.user_id = ${userId}))`,
        sql`not exists (select 1 from event_responses e where e.reminder_id = ${reminders.id} and e.user_id = ${userId} and e.answer = 'no')`,
        sql`((${reminders.recurrence} is not null and ${reminders.status} <> 'sent')
          or ${reminders.sendAt} between ${new Date(now.getTime() - 30 * DAY)} and ${new Date(now.getTime() + 365 * DAY)})`,
      ),
    )
    .limit(2000);
}

// GC6: Google refused the refresh token. Stop, and tell them once (in the app).
async function markRevoked(c: Conn) {
  await ownerDb.update(googleCalendars).set({ status: "revoked", lastError: "Google access was revoked" }).where(eq(googleCalendars.userId, c.userId));
  await ownerDb
    .insert(notifications)
    .values({
      companyId: c.companyId,
      userId: c.userId,
      kind: "calendar",
      text: "Google Calendar stopped syncing: reconnect it in your profile",
      dedupeKey: `gcal-revoked:${c.createdAt.getTime()}`,
    })
    .onConflictDoNothing();
}

// GC7: our calendar out of their Google account, and the connection gone.
export async function removeGoogle(c: Conn, f: typeof fetch = fetch) {
  await teardown({ refreshToken: decrypt(c.refreshTokenEnc), calendarId: c.calendarId }, f);
  await ownerDb.delete(googleCalendars).where(eq(googleCalendars.userId, c.userId));
}

export async function syncGoogle(userId: string, f: typeof fetch = fetch, now = new Date()): Promise<"synced" | "revoked" | "removed" | "skipped"> {
  const [x] = await ownerDb
    .select({ c: googleCalendars, enabled: companies.googleCalendarEnabled, deactivatedAt: user.deactivatedAt, tz: companies.timeZone })
    .from(googleCalendars)
    .innerJoin(companies, eq(companies.id, googleCalendars.companyId))
    .innerJoin(user, eq(user.id, googleCalendars.userId))
    .where(eq(googleCalendars.userId, userId));
  if (!x || x.c.status !== "active") return "skipped";
  // GC7: the company blocked it: take our calendar out of their Google account.
  if (!x.enabled) {
    await removeGoogle(x.c, f);
    return "removed";
  }
  if (x.deactivatedAt) return "skipped"; // GC8: stops; erasing deletes the connection
  const c = x.c;
  let access: string;
  try {
    access = await accessFor(c, f, now);
  } catch (e) {
    if (e instanceof GoogleError && e.code === "invalid_grant") {
      await markRevoked(c);
      return "revoked";
    }
    throw e;
  }
  const appUrl = (id: string) => `${new URL(`/reminders/${id}`, process.env.BETTER_AUTH_URL)}`;
  const run = async (calendarId: string) => {
    const want = await wanted(c.companyId, userId, now);
    const bodies = await ownerDb.transaction(async (tx) =>
      Promise.all(want.map(async (r) => googleEvent(r, appUrl(r.id), await exdatesOf(tx, r)))),
    );
    const have = new Map(
      (await ownerDb.select().from(googleCalendarEntries).where(eq(googleCalendarEntries.userId, userId))).map((e) => [e.reminderId, e.hash]),
    );
    for (const [i, r] of want.entries()) {
      const hash = hashOf(bodies[i]);
      if (have.get(r.id) === hash) continue;
      await putEvent(access, calendarId, bodies[i], f);
      await ownerDb
        .insert(googleCalendarEntries)
        .values({ userId, reminderId: r.id, companyId: c.companyId, hash })
        .onConflictDoUpdate({ target: [googleCalendarEntries.userId, googleCalendarEntries.reminderId], set: { hash, syncedAt: now } });
    }
    const keep = new Set(want.map((r) => r.id));
    for (const reminderId of have.keys()) {
      if (keep.has(reminderId)) continue;
      await deleteEvent(access, calendarId, googleEventId(reminderId), f);
      await ownerDb.delete(googleCalendarEntries).where(and(eq(googleCalendarEntries.userId, userId), eq(googleCalendarEntries.reminderId, reminderId)));
    }
  };
  const fresh = async () => {
    const id = await createCalendar(access, x.tz, f);
    await ownerDb.delete(googleCalendarEntries).where(eq(googleCalendarEntries.userId, userId));
    await ownerDb.update(googleCalendars).set({ calendarId: id }).where(eq(googleCalendars.userId, userId));
    return id;
  };
  try {
    try {
      await run(c.calendarId ?? (await fresh()));
    } catch (e) {
      // They deleted the "NotifyHub" calendar in Google: make it again and refill it.
      if (!(e instanceof GoogleError && (e.status === 404 || e.status === 410))) throw e;
      await run(await fresh());
    }
  } catch (e) {
    await ownerDb
      .update(googleCalendars)
      .set({ lastError: e instanceof GoogleError ? e.message : "Sync failed" })
      .where(eq(googleCalendars.userId, userId));
    throw e; // pg-boss retries
  }
  await ownerDb.update(googleCalendars).set({ lastSyncedAt: now, lastError: null }).where(eq(googleCalendars.userId, userId));
  return "synced";
}
