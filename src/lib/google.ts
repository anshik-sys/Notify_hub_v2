import { createHash } from "node:crypto";
import { rrule } from "./invite";
import type { Rule } from "./recurrence";
import { toLocalInput, zonedToUtc } from "./time";

// Section 13: Google Calendar, one way (NotifyHub -> a "NotifyHub" calendar in
// the person's Google account). Every Google call goes through here; tests
// pass a fake fetch, and GOOGLE_*_URL can point at a fake. No DB client: the
// worker imports this. Never log tokens.

// openid + email: to show "Connected as …". calendar.app.created: make our own
// calendar and manage only its events, never read the person's others.
export const GOOGLE_CALENDAR_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.app.created"];
const authUrl = () => process.env.GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
const tokenUrl = () => process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const apiBase = () => process.env.GOOGLE_API_URL ?? "https://www.googleapis.com/calendar/v3";
const revokeUrl = () => process.env.GOOGLE_REVOKE_URL ?? "https://oauth2.googleapis.com/revoke";
// Built from the origin, so a trailing slash on BETTER_AUTH_URL can't break Google's exact match.
export const googleRedirectUri = () => new URL("/api/google/oauth", process.env.BETTER_AUTH_URL).toString();

export class GoogleError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`Google: ${status} ${code}`);
  }
}

type Fetch = typeof fetch;

// offline + consent: a refresh token every time, so syncing works signed out.
export function consentUrl(state: string) {
  const u = new URL(authUrl());
  u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", googleRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

async function token(params: Record<string, string>, f: Fetch) {
  const res = await f(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", ...params }),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; scope?: string; error?: string };
  if (!res.ok || !json.access_token) throw new GoogleError(res.status, json.error ?? "token_failed");
  return json;
}

// The code from the redirect -> tokens and the Google account's email. The
// id_token comes straight from Google's token endpoint over TLS, so its
// payload is read without checking the signature (OpenID Connect 3.1.3.7).
export async function exchangeCode(code: string, f: Fetch = fetch, now = new Date()) {
  const t = await token({ code, grant_type: "authorization_code", redirect_uri: googleRedirectUri() }, f);
  if (!t.refresh_token) throw new GoogleError(400, "no_refresh_token");
  if (!t.scope?.includes("calendar.app.created")) throw new GoogleError(400, "scope_not_granted");
  const payload = JSON.parse(Buffer.from((t.id_token ?? "..").split(".")[1] ?? "", "base64url").toString() || "{}") as { email?: string };
  return { refreshToken: t.refresh_token, accessToken: t.access_token!, expiresAt: new Date(now.getTime() + (t.expires_in ?? 3600) * 1000), email: payload.email ?? "your Google account" };
}

// invalid_grant: access was revoked (or the password changed): reconnect needed (GC6).
export async function refreshAccess(refreshToken: string, f: Fetch = fetch, now = new Date()) {
  const t = await token({ refresh_token: refreshToken, grant_type: "refresh_token" }, f);
  return { accessToken: t.access_token!, expiresAt: new Date(now.getTime() + (t.expires_in ?? 3600) * 1000) };
}

export async function revoke(tokenValue: string, f: Fetch = fetch) {
  await f(`${revokeUrl()}?token=${encodeURIComponent(tokenValue)}`, { method: "POST" }).catch(() => {});
}

async function calApi<T>(accessToken: string, method: string, path: string, body: unknown, f: Fetch): Promise<T> {
  const res = await f(`${apiBase()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as T & { error?: { status?: string; errors?: { reason?: string }[] } };
  if (!res.ok) throw new GoogleError(res.status, json.error?.errors?.[0]?.reason ?? json.error?.status ?? "error");
  return json;
}

export const createCalendar = async (accessToken: string, timeZone: string, f: Fetch = fetch) =>
  (await calApi<{ id: string }>(accessToken, "POST", "/calendars", { summary: "NotifyHub", description: "Reminders, tasks and events from NotifyHub. Changes made here are overwritten.", timeZone }, f)).id;

export async function deleteCalendar(accessToken: string, calendarId: string, f: Fetch = fetch) {
  await calApi(accessToken, "DELETE", `/calendars/${encodeURIComponent(calendarId)}`, null, f).catch((e) => {
    if (!(e instanceof GoogleError && (e.status === 404 || e.status === 410))) throw e;
  });
}

// Update by our stable id; a first write (404) inserts it. An entry deleted
// earlier is still known to Google as cancelled: the update brings it back
// ("status": "confirmed").
export async function putEvent(accessToken: string, calendarId: string, body: GoogleEvent, f: Fetch = fetch) {
  const cal = encodeURIComponent(calendarId);
  try {
    await calApi(accessToken, "PUT", `/calendars/${cal}/events/${body.id}`, body, f);
  } catch (e) {
    if (!(e instanceof GoogleError && e.status === 404)) throw e;
    await calApi(accessToken, "POST", `/calendars/${cal}/events`, body, f);
  }
}

export async function deleteEvent(accessToken: string, calendarId: string, eventId: string, f: Fetch = fetch) {
  await calApi(accessToken, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, null, f).catch((e) => {
    if (!(e instanceof GoogleError && (e.status === 404 || e.status === 410))) throw e;
  });
}

// --- An entry as a Google event ----------------------------------------------------------
// Google event ids are base32hex (a-v, 0-9): "nh" + the reminder's uuid hex fits.
export const googleEventId = (reminderId: string) => `nh${reminderId.replace(/-/g, "")}`;

export type Entry = {
  id: string;
  title: string;
  description: string;
  sendAt: Date;
  recurrence: Rule | null;
  anchorLocal: string;
  timeZone: string;
  isEvent: boolean;
  isTask: boolean;
  durationMinutes: number | null;
  allDay: boolean;
  location: string | null;
  meetingUrl: string | null;
};
export type GoogleEvent = ReturnType<typeof googleEvent>;

const DAY = 86_400_000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const stamp = (local: string) => `${local.replace(/[-:]/g, "")}00`;

// GC12-GC14: reminders and tasks are 30 minutes at their send time (as on the
// NotifyHub calendar); events have their real length or are all day; a
// series repeats, minus its removed dates. No Google pop-ups: NotifyHub
// notifies by itself. Reminders and tasks don't block time.
export function googleEvent(e: Entry, appUrl: string, exdates: string[] = []) {
  const minutes = e.isEvent ? (e.durationMinutes ?? 60) : 30;
  const startLocal = e.recurrence ? e.anchorLocal : toLocalInput(e.sendAt, e.timeZone);
  const start = e.recurrence ? zonedToUtc(e.anchorLocal, e.timeZone)! : e.sendAt;
  const when =
    e.isEvent && e.allDay
      ? { start: { date: startLocal.slice(0, 10) }, end: { date: addDays(startLocal.slice(0, 10), Math.round(minutes / 1440)) } }
      : {
          start: { dateTime: start.toISOString(), timeZone: e.timeZone },
          end: { dateTime: new Date(start.getTime() + minutes * 60_000).toISOString(), timeZone: e.timeZone },
        };
  const ex = e.recurrence && exdates.length
    ? [e.isEvent && e.allDay
        ? `EXDATE;VALUE=DATE:${exdates.map((x) => toLocalInput(new Date(x), e.timeZone).slice(0, 10).replace(/-/g, "")).join(",")}`
        : `EXDATE;TZID=${e.timeZone}:${exdates.map((x) => stamp(toLocalInput(new Date(x), e.timeZone))).join(",")}`]
    : [];
  const kind = e.isEvent ? "" : e.isTask ? "Task: " : "Reminder: ";
  return {
    id: googleEventId(e.id),
    status: "confirmed",
    summary: `${kind}${e.title}`.slice(0, 1000),
    description: [e.description, e.meetingUrl && `Join: ${e.meetingUrl}`, `Open in NotifyHub: ${appUrl}`, "From NotifyHub: changes made here are overwritten."]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 8000),
    ...(e.isEvent && e.location ? { location: e.location } : {}),
    ...when,
    ...(e.recurrence ? { recurrence: [`RRULE:${rrule(e.recurrence, e.anchorLocal, e.timeZone)}`, ...ex] } : {}),
    transparency: e.isEvent ? "opaque" : "transparent",
    reminders: { useDefault: false, overrides: [] as never[] },
    source: { title: "NotifyHub", url: appUrl },
  };
}

// What was written, so the next sync only writes what changed.
export const hashOf = (body: GoogleEvent) => createHash("sha256").update(JSON.stringify(body)).digest("hex");

// Disconnect / blocked / erased (GC5, GC7, GC8): delete our calendar from
// their Google account (best effort: access may already be gone) and revoke
// the grant. The caller deletes the stored connection.
export async function teardown(c: { refreshToken: string; calendarId: string | null }, f: Fetch = fetch) {
  try {
    const { accessToken } = await refreshAccess(c.refreshToken, f);
    if (c.calendarId) await deleteCalendar(accessToken, c.calendarId, f);
  } catch (e) {
    console.error("Google calendar delete failed", e instanceof GoogleError ? e.message : "error");
  }
  await revoke(c.refreshToken, f);
}
