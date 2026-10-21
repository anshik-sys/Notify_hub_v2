import assert from "node:assert/strict";
import { test } from "node:test";
import { signToken } from "./crypto";
import { announce, answerOpen, changes, dueNotices, eventIcs, eventWhen, readRsvp, rrule, rsvpUrl, startsIn } from "./invite";
import { unsubscribeToken } from "./unsubscribe";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Planning, Q4; budget",
  description: "Bring numbers\nand ideas",
  sendAt: new Date("2026-11-04T10:00:00Z"),
  durationMinutes: 90,
  allDay: false,
  location: "Room 2",
  meetingUrl: "https://meet.example.com/abc",
  recurrence: null,
  anchorLocal: "2026-11-04T14:00",
  timeZone: "Asia/Dubai",
};
const people = { organizer: { name: "Olga", email: "olga@x.test" }, attendee: { name: "Al", email: "al@x.test" }, url: "https://app.test/reminders/1", now: new Date("2026-10-21T08:00:00Z") };
// Unfolded (a long line continues after CRLF + space).
const lines = (ics: string) => ics.replace(/\r\n /g, "").split("\r\n");

test("ics: a one-time event in UTC with title, place, link and both people", () => {
  const ics = eventIcs(base, people);
  const l = lines(ics);
  assert.ok(ics.endsWith("\r\n"));
  assert.ok(l.includes("METHOD:REQUEST"));
  assert.ok(l.includes(`UID:${base.id}@notifyhub`));
  assert.ok(l.includes("DTSTART:20261104T100000Z"));
  assert.ok(l.includes("DTEND:20261104T113000Z"));
  assert.ok(l.includes("SUMMARY:Planning\\, Q4\\; budget"));
  assert.ok(l.includes("LOCATION:Room 2"));
  assert.ok(l.includes("URL:https://meet.example.com/abc"));
  assert.ok(l.some((x) => x.startsWith('ORGANIZER;CN="Olga":mailto:olga@x.test')));
  assert.ok(l.some((x) => x.includes("mailto:al@x.test") && x.startsWith("ATTENDEE")));
  assert.ok(!l.some((x) => x.startsWith("RRULE")));
  // Folded at 75 octets.
  assert.ok(ics.split("\r\n").every((x) => Buffer.byteLength(x) <= 75));
});

test("ics: all day over three days is dates only, end exclusive", () => {
  const l = lines(eventIcs({ ...base, allDay: true, durationMinutes: 3 * 1440, sendAt: new Date("2026-11-11T20:00:00Z") }, people));
  assert.ok(l.includes("DTSTART;VALUE=DATE:20261112"));
  assert.ok(l.includes("DTEND;VALUE=DATE:20261115"));
});

test("ics: a series is one VEVENT in its zone with an RRULE (IN4)", () => {
  const recurrence = { freq: "weekly" as const, interval: 1, weekdays: [0, 2], end: { type: "count" as const, count: 10 } };
  const l = lines(eventIcs({ ...base, recurrence, anchorLocal: "2026-11-02T10:00", sendAt: new Date("2026-11-09T06:00:00Z") }, people));
  assert.equal(l.filter((x) => x === "BEGIN:VEVENT").length, 1);
  assert.ok(l.includes("DTSTART;TZID=Asia/Dubai:20261102T100000"));
  assert.ok(l.includes("DTEND;TZID=Asia/Dubai:20261102T113000"));
  assert.ok(l.includes("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=10"));
});

test("rrule: monthly by weekday and day, until the end of a day in the zone", () => {
  // 2026-11-10 is the 2nd Tuesday.
  assert.equal(rrule({ freq: "monthly", interval: 1, monthly: { by: "weekday", nth: 2 }, end: { type: "never" } }, "2026-11-10T09:00", "UTC"), "FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU");
  assert.equal(rrule({ freq: "monthly", interval: 2, end: { type: "never" } }, "2026-11-10T09:00", "UTC"), "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=10");
  assert.equal(
    rrule({ freq: "daily", interval: 1, end: { type: "until", date: "2026-12-01" } }, "2026-11-10T09:00", "Asia/Dubai"),
    "FREQ=DAILY;INTERVAL=1;UNTIL=20261201T195959Z",
  );
});

test("when: timed, all day and a series", () => {
  assert.equal(eventWhen(base), "4 Nov 2026, 14:00 – 15:30 (Asia/Dubai)");
  assert.equal(eventWhen({ ...base, allDay: true, durationMinutes: 2880, sendAt: new Date("2026-11-11T20:00:00Z") }), "12 Nov 2026 – 13 Nov 2026, all day");
  assert.match(eventWhen({ ...base, recurrence: { freq: "daily", interval: 1, end: { type: "never" } } }), /\. Every day$/);
});

test("answers stay open until the end; a series until its last date", () => {
  const now = new Date("2026-11-04T11:00:00Z"); // during the event
  assert.equal(answerOpen({ ...base, status: "sent" }, now), true);
  assert.equal(answerOpen({ ...base, status: "sent" }, new Date("2026-11-04T11:30:00Z")), false);
  assert.equal(answerOpen({ ...base, status: "pending_approval" }, now), false);
  assert.equal(answerOpen({ ...base, status: "scheduled", recurrence: { freq: "daily", interval: 1, end: { type: "never" } }, sendAt: new Date(0) }, now), true);
});

test("reply links: signed per guest and event; other tokens don't work (RS2)", () => {
  const c = "22222222-2222-4222-8222-222222222222";
  const url = rsvpUrl(c, base.id, "user:with:colons", "maybe");
  const token = decodeURIComponent(url.split("/rsvp/")[1].split("?")[0]);
  assert.ok(url.endsWith("?a=maybe"));
  assert.deepEqual(readRsvp(token), { companyId: c, eventId: base.id, userId: "user:with:colons" });
  // Edited data with the old signature, or another purpose's token.
  const [, sig] = token.split(".");
  assert.equal(readRsvp(`${Buffer.from(`${c}:${base.id}:someone-else`).toString("base64url")}.${sig}`), null);
  assert.equal(readRsvp(unsubscribeToken(c, "x@y.test")), null);
  assert.equal(readRsvp(signToken("unsubscribe", `${c}:${base.id}:u1`)), null);
});

test("starts soon: the smallest due notice per date, never after the start, none for []", () => {
  const e = { ...base, notifyBefore: [10, 1440] }; // starts 2026-11-04T10:00Z
  const at = (iso: string) => dueNotices(e, new Date(iso)).map((n) => n.minutes);
  assert.deepEqual(at("2026-11-03T09:59:00Z"), []); // more than a day before
  assert.deepEqual(at("2026-11-03T10:00:00Z"), [1440]);
  assert.deepEqual(at("2026-11-04T09:50:00Z"), [10]); // both due: only the later one
  assert.deepEqual(at("2026-11-04T10:00:00Z"), []); // started
  assert.deepEqual(dueNotices({ ...e, notifyBefore: [] }, new Date("2026-11-04T09:55:00Z")), []);
});

test("starts soon: every date of a series; an all-day date counts from 09:00", () => {
  const daily = { ...base, notifyBefore: [10], recurrence: { freq: "daily" as const, interval: 1, end: { type: "never" as const } }, anchorLocal: "2026-11-02T14:00" };
  // 14:00 Dubai = 10:00Z, each day.
  assert.deepEqual(dueNotices(daily, new Date("2026-11-05T09:52:00Z")).map((n) => n.occursAt.toISOString()), ["2026-11-05T10:00:00.000Z"]);
  const allDay = { ...base, allDay: true, durationMinutes: 1440, notifyBefore: [10], sendAt: new Date("2026-11-03T20:00:00Z") }; // 4 Nov, Dubai
  assert.deepEqual(dueNotices(allDay, new Date("2026-11-04T04:49:00Z")), []);
  assert.deepEqual(dueNotices(allDay, new Date("2026-11-04T04:50:00Z")).map((n) => n.startsAt.toISOString()), ["2026-11-04T05:00:00.000Z"]); // 09:00 Dubai
});

test("startsIn: minutes, hours, days", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  assert.equal(startsIn(new Date("2026-11-04T10:10:00Z"), now), "in 10 minutes");
  assert.equal(startsIn(new Date("2026-11-04T10:00:20Z"), now), "in 1 minute");
  assert.equal(startsIn(new Date("2026-11-04T12:00:00Z"), now), "in 2 hours");
  assert.equal(startsIn(new Date("2026-11-05T10:00:00Z"), now), "in 1 day");
});

test("changes: time, place, link and dates; description doesn't count", () => {
  const a = announce(base, [], 0);
  assert.deepEqual(changes(a, announce({ ...base }, [], 0)), []);
  assert.deepEqual(changes(a, announce({ ...base, location: "Room 5" }, [], 0)), ["Where: Room 5 (was Room 2)"]);
  assert.deepEqual(changes(a, announce({ ...base, meetingUrl: null }, [], 0)), ["The meeting link was removed"]);
  assert.match(changes(a, announce({ ...base, durationMinutes: 30 }, [], 0))[0], /^When: 4 Nov 2026, 14:00 – 14:30 \(Asia\/Dubai\) \(was 4 Nov 2026, 14:00 – 15:30/);
  // A series: its next date moving on by itself isn't a change; a skipped date is.
  const weekly = { ...base, recurrence: { freq: "weekly" as const, interval: 1, end: { type: "never" as const } } };
  const s0 = announce(weekly, [], 0);
  assert.deepEqual(changes(s0, announce({ ...weekly, sendAt: new Date("2026-11-11T10:00:00Z") }, [], 0)), []);
  assert.deepEqual(changes(s0, announce(weekly, ["2026-11-11T10:00:00.000Z"], 0)), ["Not on: 11 Nov 2026, 14:00"]);
});

test("ics: a cancel carries METHOD:CANCEL, STATUS:CANCELLED and the version", () => {
  const ics = eventIcs(base, { ...people, method: "CANCEL", sequence: 3 });
  assert.match(ics, /METHOD:CANCEL/);
  assert.match(ics, /SEQUENCE:3/);
  assert.match(ics, /STATUS:CANCELLED/);
});
