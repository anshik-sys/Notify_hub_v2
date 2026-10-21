import { EVENT_ANSWERS, type EventAnswer } from "@/db/schema";
import { readToken, signToken } from "./crypto";
import { describe, type Rule } from "./recurrence";
import { formatInZone, toLocalInput, zonedToUtc } from "./time";
import { isUuid } from "./validate";

// PRD 14.3 invites, shared by the worker (which sends them) and the web app
// (the reply page, the event page). No DB client here: the worker imports it.

type Event = {
  id: string;
  title: string;
  description: string;
  sendAt: Date;
  durationMinutes: number | null;
  allDay: boolean;
  location: string | null;
  meetingUrl: string | null;
  recurrence: Rule | null;
  anchorLocal: string;
  timeZone: string;
};

// --- Reply links (RS2) --------------------------------------------------------
// Signed per company, event and guest, like unsubscribe links: they work
// without signing in, and nobody can answer for someone else. The page asks
// for a click first (mail scanners open links).
const PURPOSE = "rsvp";

export const rsvpUrl = (companyId: string, eventId: string, userId: string, answer: EventAnswer) =>
  `${process.env.BETTER_AUTH_URL}/rsvp/${signToken(PURPOSE, `${companyId}:${eventId}:${userId}`)}?a=${answer}`;

export function readRsvp(token: string) {
  const data = token.length <= 1000 ? readToken(PURPOSE, token) : null;
  // User ids are text and may hold anything but the two leading uuids.
  const m = data && /^([0-9a-f-]{36}):([0-9a-f-]{36}):(.{1,200})$/.exec(data);
  return m && isUuid(m[1]) && isUuid(m[2]) ? { companyId: m[1], eventId: m[2], userId: m[3] } : null;
}

export const isAnswer = (a: unknown): a is EventAnswer => EVENT_ANSWERS.includes(a as EventAnswer);
export const ANSWER_LABEL = { yes: "Yes", no: "No", maybe: "Maybe" } as const;

// --- When -----------------------------------------------------------------------

const DAY = 86_400_000;
const dateOnly = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: tz }).format(d);

// "4 Nov 2026, 14:00 – 15:30 (Asia/Dubai)", "4 Nov 2026, all day",
// "12 Nov 2026 – 14 Nov 2026, all day". A series shows the next date and how it repeats.
export function eventWhen(e: Pick<Event, "sendAt" | "durationMinutes" | "allDay" | "recurrence" | "anchorLocal" | "timeZone">) {
  const tz = e.timeZone;
  const minutes = e.durationMinutes ?? 60;
  const end = new Date(e.sendAt.getTime() + minutes * 60_000);
  let s: string;
  if (e.allDay) {
    const days = Math.round(minutes / 1440);
    s = `${dateOnly(e.sendAt, tz)}${days > 1 ? ` – ${dateOnly(new Date(end.getTime() - DAY), tz)}` : ""}, all day`;
  } else {
    // The end without its date when it's the same day.
    const sameDay = toLocalInput(end, tz).slice(0, 10) === toLocalInput(e.sendAt, tz).slice(0, 10);
    s = `${formatInZone(e.sendAt, tz)} – ${sameDay ? toLocalInput(end, tz).slice(11, 16) : formatInZone(end, tz)} (${tz})`;
  }
  return e.recurrence ? `${s}. ${describe(e.recurrence, e.anchorLocal)}` : s;
}

// The end of the event (a series: the end of its next date).
export const eventEnd = (e: { sendAt: Date; durationMinutes: number | null }) => new Date(e.sendAt.getTime() + (e.durationMinutes ?? 60) * 60_000);

// Guests can answer, and change it, once it's scheduled and until it ends
// (RS1); a series until its last date has ended.
export const answerOpen = (e: { status: string; recurrence: Rule | null; sendAt: Date; durationMinutes: number | null }, now = new Date()) =>
  ["scheduled", "paused", "sent"].includes(e.status) && ((e.recurrence !== null && e.status !== "sent") || eventEnd(e) > now);

// --- The .ics file (IN3, IN4) ------------------------------------------------------
// One VEVENT per event; a series carries its RRULE, so it's one invite. A
// one-time event is in UTC. A series is in its zone (TZID, no VTIMEZONE: Google,
// Outlook and Apple resolve IANA names), so 10:00 stays 10:00 across DST.
// ponytail: no EXDATE for skipped or moved dates yet (change notices, slice 4).

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const localStamp = (local: string) => `${local.replace(/[-:]/g, "")}00`; // "2026-11-04T10:00" -> 20261104T100000
const dateStamp = (local: string) => local.slice(0, 10).replace(/-/g, "");
const addLocalDays = (local: string, n: number) => new Date(Date.parse(`${local.slice(0, 10)}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// RFC 5545 text: escape \ ; , and newlines.
const text = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// Lines longer than 75 octets continue on the next line after a space.
function fold(line: string) {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 75) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  return [...out, cur].join("\r\n");
}

// ponytail: our monthly "day 31" falls back to the month's last day; RRULE
// BYMONTHDAY=31 skips short months instead. Rare for meetings; add
// BYMONTHDAY=28,29,30,31 with BYSETPOS=-1 if anyone repeats on the 29th-31st.
export function rrule(rule: Rule, anchorLocal: string, tz: string) {
  const day = new Date(`${anchorLocal.slice(0, 10)}T00:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7;
  const parts = [`FREQ=${rule.freq.toUpperCase()}`, `INTERVAL=${rule.interval}`];
  if (rule.freq === "weekly") parts.push(`BYDAY=${(rule.weekdays?.length ? [...rule.weekdays].sort() : [weekday]).map((w) => WEEKDAYS[w]).join(",")}`);
  if (rule.freq === "monthly")
    parts.push(rule.monthly?.by === "weekday" ? `BYDAY=${rule.monthly.nth}${WEEKDAYS[weekday]}` : `BYMONTHDAY=${day.getUTCDate()}`);
  // UNTIL is inclusive and, with a TZID start, in UTC: the end of that day in the zone.
  if (rule.end.type === "until") parts.push(`UNTIL=${utcStamp(new Date(zonedToUtc(`${rule.end.date}T23:59`, tz)!.getTime() + 59_000))}`);
  if (rule.end.type === "count") parts.push(`COUNT=${rule.end.count}`);
  return parts.join(";");
}

export function eventIcs(
  e: Event,
  p: { organizer: { name: string; email: string }; attendee: { name: string; email: string }; url: string; now?: Date },
) {
  const minutes = e.durationMinutes ?? 60;
  // A series starts at its first date (the anchor); a one-time event at send_at.
  const startLocal = e.recurrence ? e.anchorLocal : toLocalInput(e.sendAt, e.timeZone);
  const start = e.recurrence ? zonedToUtc(e.anchorLocal, e.timeZone)! : e.sendAt;
  const end = new Date(start.getTime() + minutes * 60_000);
  const when = e.allDay
    ? [`DTSTART;VALUE=DATE:${dateStamp(startLocal)}`, `DTEND;VALUE=DATE:${dateStamp(addLocalDays(startLocal, Math.round(minutes / 1440)))}`]
    : e.recurrence
      ? [`DTSTART;TZID=${e.timeZone}:${localStamp(startLocal)}`, `DTEND;TZID=${e.timeZone}:${localStamp(toLocalInput(end, e.timeZone))}`]
      : [`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`];
  const description = [e.description, e.meetingUrl && `Join: ${e.meetingUrl}`, `Reply in NotifyHub: ${p.url}`].filter(Boolean).join("\n\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NotifyHub//Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${e.id}@notifyhub`,
    "SEQUENCE:0",
    `DTSTAMP:${utcStamp(p.now ?? new Date())}`,
    ...when,
    ...(e.recurrence ? [`RRULE:${rrule(e.recurrence, e.anchorLocal, e.timeZone)}`] : []),
    `SUMMARY:${text(e.title)}`,
    `DESCRIPTION:${text(description)}`,
    ...(e.location ? [`LOCATION:${text(e.location)}`] : []),
    ...(e.meetingUrl ? [`URL:${e.meetingUrl}`] : []),
    `ORGANIZER;CN="${p.organizer.name.replace(/"/g, "'")}":mailto:${p.organizer.email}`,
    // RSVP=FALSE: answers come back through our links and buttons, not as iMIP replies.
    `ATTENDEE;CN="${p.attendee.name.replace(/"/g, "'")}";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${p.attendee.email}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
