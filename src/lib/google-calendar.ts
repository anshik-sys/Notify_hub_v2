import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { companies, googleCalendars } from "@/db/schema";
import { decrypt, encrypt } from "./crypto";
import { exchangeCode, GoogleError, teardown } from "./google";

// Section 13, web side: connect, show, disconnect. The worker does the
// syncing (src/worker/google-sync.ts). Tokens only ever stored encrypted.

export const GOOGLE_STATE_COOKIE = "google_oauth_state";

export async function googleAllowed(companyId: string) {
  const [c] = await withTenant(companyId, (tx) => tx.select({ on: companies.googleCalendarEnabled }).from(companies).where(eq(companies.id, companyId)));
  return Boolean(c?.on && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export async function getGoogleConnection(companyId: string, userId: string) {
  const [c] = await withTenant(companyId, (tx) =>
    tx
      .select({ googleEmail: googleCalendars.googleEmail, status: googleCalendars.status, lastSyncedAt: googleCalendars.lastSyncedAt, lastError: googleCalendars.lastError })
      .from(googleCalendars)
      .where(eq(googleCalendars.userId, userId)),
  );
  return c ?? null;
}

// GC1-GC4: the code from Google's redirect -> an encrypted connection (any
// Google account, GC2). Reconnecting replaces the old one; the worker makes the
// calendar and fills it on its next run. Returns an error string or null.
export async function connectGoogle(companyId: string, userId: string, code: string, f?: typeof fetch) {
  if (!(await googleAllowed(companyId))) return "Google Calendar is turned off for your company.";
  let t;
  try {
    t = await exchangeCode(code, f);
  } catch (e) {
    if (e instanceof GoogleError && e.code === "scope_not_granted") return "Google didn't give access to calendars. Try again and allow it.";
    console.error("Google token exchange failed", e instanceof GoogleError ? e.message : "error");
    return "Google didn't accept the connection. Try again.";
  }
  const row = { googleEmail: t.email, refreshTokenEnc: encrypt(t.refreshToken), accessTokenEnc: encrypt(t.accessToken), accessExpiresAt: t.expiresAt, status: "active" as const, lastError: null };
  // A reconnect keeps the calendar (and what's in it) if it still exists.
  await withTenant(companyId, (tx) =>
    tx
      .insert(googleCalendars)
      .values({ userId, companyId, ...row })
      .onConflictDoUpdate({ target: googleCalendars.userId, set: row }),
  );
  return null;
}

// GC5: stop, delete the "NotifyHub" calendar from Google, forget the tokens.
export async function disconnectGoogle(companyId: string, userId: string, f?: typeof fetch) {
  const [c] = await withTenant(companyId, (tx) =>
    tx.select({ refreshTokenEnc: googleCalendars.refreshTokenEnc, calendarId: googleCalendars.calendarId }).from(googleCalendars).where(eq(googleCalendars.userId, userId)),
  );
  if (!c) return;
  await teardown({ refreshToken: decrypt(c.refreshTokenEnc), calendarId: c.calendarId }, f);
  await withTenant(companyId, (tx) => tx.delete(googleCalendars).where(and(eq(googleCalendars.userId, userId), eq(googleCalendars.companyId, companyId))));
}

// GC7: admins allow or block it for the company. Blocking takes effect on
// the worker's next run (it deletes each person's calendar).
export async function setGoogleCalendarEnabled(companyId: string, on: boolean) {
  await withTenant(companyId, (tx) => tx.update(companies).set({ googleCalendarEnabled: on }).where(eq(companies.id, companyId)));
}
