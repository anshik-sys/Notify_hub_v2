import assert from "node:assert/strict";
import { test } from "node:test";
import { consentUrl, exchangeCode, googleEvent, googleEventId, hashOf } from "./google";

const base = {
  id: "11111111-2222-4333-8444-555555555555",
  title: "Planning",
  description: "Agenda",
  sendAt: new Date("2031-03-03T10:00:00Z"),
  recurrence: null,
  anchorLocal: "2031-03-03T14:00",
  timeZone: "Asia/Dubai",
  isEvent: false,
  isTask: false,
  durationMinutes: null,
  allDay: false,
  location: "Room 2",
  meetingUrl: null,
};
const url = "https://app.test/reminders/1";

test("event ids are valid Google ids (base32hex, 5-1024) and stable", () => {
  const id = googleEventId(base.id);
  assert.match(id, /^[a-v0-9]{5,1024}$/);
  assert.equal(id, googleEventId(base.id));
});

test("a reminder: 30 minutes at its send time, doesn't block time, no location, link back (GC12)", () => {
  const e = googleEvent(base, url);
  assert.equal(e.summary, "Reminder: Planning");
  assert.deepEqual([e.start, e.end], [
    { dateTime: "2031-03-03T10:00:00.000Z", timeZone: "Asia/Dubai" },
    { dateTime: "2031-03-03T10:30:00.000Z", timeZone: "Asia/Dubai" },
  ]);
  assert.equal(e.transparency, "transparent");
  assert.equal("location" in e, false);
  assert.match(e.description, /Open in NotifyHub: https:\/\/app\.test\/reminders\/1/);
  assert.match(e.description, /changes made here are overwritten/);
  assert.deepEqual(e.reminders, { useDefault: false, overrides: [] });
  assert.equal(googleEvent({ ...base, isTask: true }, url).summary, "Task: Planning");
});

test("an event: real length, place and Join; all day as dates (GC13)", () => {
  const e = googleEvent({ ...base, isEvent: true, durationMinutes: 90, meetingUrl: "https://meet.test/x" }, url);
  assert.equal(e.summary, "Planning");
  assert.equal(e.end && "dateTime" in e.end && e.end.dateTime, "2031-03-03T11:30:00.000Z");
  assert.equal(e.location, "Room 2");
  assert.match(e.description, /Join: https:\/\/meet\.test\/x/);
  assert.equal(e.transparency, "opaque");
  const day = googleEvent({ ...base, isEvent: true, allDay: true, durationMinutes: 2 * 1440, sendAt: new Date("2031-03-02T20:00:00Z") }, url);
  assert.deepEqual([day.start, day.end], [{ date: "2031-03-03" }, { date: "2031-03-05" }]);
});

test("a series: from its first date, with its rule and removed dates (GC14)", () => {
  const e = googleEvent({ ...base, recurrence: { freq: "weekly", interval: 1, end: { type: "never" } } }, url, ["2031-03-10T10:00:00.000Z"]);
  assert.equal(e.start && "dateTime" in e.start && e.start.dateTime, "2031-03-03T10:00:00.000Z");
  assert.deepEqual(e.recurrence, ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", "EXDATE;TZID=Asia/Dubai:20310310T140000"]);
});

test("the hash changes with the content only", () => {
  assert.equal(hashOf(googleEvent(base, url)), hashOf(googleEvent({ ...base }, url)));
  assert.notEqual(hashOf(googleEvent(base, url)), hashOf(googleEvent({ ...base, title: "Other" }, url)));
});

test("consent: offline, consent prompt, only the calendar.app.created calendar scope (GC1)", () => {
  const u = new URL(consentUrl("st"));
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("state"), "st");
  assert.deepEqual(u.searchParams.get("scope")!.split(" "), ["openid", "email", "https://www.googleapis.com/auth/calendar.app.created"]);
  assert.match(u.searchParams.get("redirect_uri")!, /\/api\/google\/oauth$/);
  assert.doesNotMatch(u.searchParams.get("redirect_uri")!, /\/\/api/); // a trailing slash on BETTER_AUTH_URL doesn't double it
});

test("exchange: tokens and the Google email; refused without the calendar scope or a refresh token", async () => {
  const idToken = `x.${Buffer.from(JSON.stringify({ email: "me@gmail.test" })).toString("base64url")}.y`;
  const fake = (body: object) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  const ok = await exchangeCode("c", fake({ access_token: "a", refresh_token: "r", expires_in: 3600, id_token: idToken, scope: "openid email https://www.googleapis.com/auth/calendar.app.created" }));
  assert.deepEqual([ok.refreshToken, ok.accessToken, ok.email], ["r", "a", "me@gmail.test"]);
  await assert.rejects(exchangeCode("c", fake({ access_token: "a", refresh_token: "r", scope: "openid email" })), /scope_not_granted/);
  await assert.rejects(exchangeCode("c", fake({ access_token: "a", scope: "calendar.app.created" })), /no_refresh_token/);
});
