import assert from "node:assert/strict";
import { test } from "node:test";
import { between, describe, firstAtOrAfter, nextAfter, occurrences, type Rule, ruleFromForm } from "./recurrence";
import { toLocalInput } from "./time";

const never = { type: "never" } as const;
// First n occurrences as local wall-clock strings in tz.
const take = (rule: Rule, anchor: string, n: number, tz = "UTC") => {
  const out: string[] = [];
  for (const at of occurrences(rule, anchor, tz)) {
    out.push(toLocalInput(at, tz));
    if (out.length === n) break;
  }
  return out;
};

test("daily, every 3 days", () => {
  assert.deepEqual(take({ freq: "daily", interval: 3, end: never }, "2026-10-30T09:00", 3), [
    "2026-10-30T09:00",
    "2026-11-02T09:00",
    "2026-11-05T09:00",
  ]);
});

test("every weekday skips weekends", () => {
  // 2026-10-09 is a Friday.
  assert.deepEqual(take({ freq: "weekly", interval: 1, weekdays: [0, 1, 2, 3, 4], end: never }, "2026-10-09T09:00", 3), [
    "2026-10-09T09:00",
    "2026-10-12T09:00",
    "2026-10-13T09:00",
  ]);
});

test("every 2 weeks on Mon and Wed, starting on a Wednesday", () => {
  // 2026-10-07 is a Wednesday: that week's Monday is already past.
  assert.deepEqual(take({ freq: "weekly", interval: 2, weekdays: [2, 0], end: never }, "2026-10-07T10:00", 4), [
    "2026-10-07T10:00",
    "2026-10-19T10:00",
    "2026-10-21T10:00",
    "2026-11-02T10:00",
  ]);
});

test("monthly on the 31st: no drift", () => {
  assert.deepEqual(take({ freq: "monthly", interval: 1, monthly: { by: "day" }, end: never }, "2027-01-31T09:00", 5), [
    "2027-01-31T09:00",
    "2027-02-28T09:00",
    "2027-03-31T09:00",
    "2027-04-30T09:00",
    "2027-05-31T09:00",
  ]);
  // Leap year February.
  assert.equal(take({ freq: "monthly", interval: 1, monthly: { by: "day" }, end: never }, "2028-01-31T09:00", 2)[1], "2028-02-29T09:00");
});

test("monthly on the 3rd Tuesday and the last Friday", () => {
  // 2026-10-20 is the 3rd Tuesday of October.
  assert.deepEqual(take({ freq: "monthly", interval: 1, monthly: { by: "weekday", nth: 3 }, end: never }, "2026-10-20T09:00", 3), [
    "2026-10-20T09:00",
    "2026-11-17T09:00",
    "2026-12-15T09:00",
  ]);
  // Last Friday: Oct 2026 has five Fridays (30th), Nov has four (27th), Jan 2027 five (29th).
  assert.deepEqual(take({ freq: "monthly", interval: 1, monthly: { by: "weekday", nth: -1 }, end: never }, "2026-10-30T17:00", 4), [
    "2026-10-30T17:00",
    "2026-11-27T17:00",
    "2026-12-25T17:00",
    "2027-01-29T17:00",
  ]);
});

test("yearly on 29 Feb", () => {
  assert.deepEqual(take({ freq: "yearly", interval: 1, end: never }, "2028-02-29T08:00", 5), [
    "2028-02-29T08:00",
    "2029-02-28T08:00",
    "2030-02-28T08:00",
    "2031-02-28T08:00",
    "2032-02-29T08:00",
  ]);
});

test("ends: until (inclusive of that day) and count", () => {
  const until: Rule = { freq: "daily", interval: 1, end: { type: "until", date: "2026-10-09" } };
  assert.deepEqual(take(until, "2026-10-07T23:30", 10), ["2026-10-07T23:30", "2026-10-08T23:30", "2026-10-09T23:30"]);
  const count: Rule = { freq: "weekly", interval: 1, weekdays: [0, 2], end: { type: "count", count: 3 } };
  assert.deepEqual(take(count, "2026-10-05T09:00", 10), ["2026-10-05T09:00", "2026-10-07T09:00", "2026-10-12T09:00"]);
});

test("DST: 09:00 New York stays 09:00 local; the gap day moves forward only that day", () => {
  const daily: Rule = { freq: "daily", interval: 1, end: never };
  const tz = "America/New_York";
  const utc = (anchor: string, n: number) => {
    const out: string[] = [];
    for (const at of occurrences(daily, anchor, tz)) if (out.push(at.toISOString()) === n) break;
    return out;
  };
  // Spring forward 2026-03-08: EST (UTC-5) -> EDT (UTC-4).
  assert.deepEqual(utc("2026-03-07T09:00", 2), ["2026-03-07T14:00:00.000Z", "2026-03-08T13:00:00.000Z"]);
  // Fall back 2026-11-01.
  assert.deepEqual(utc("2026-10-31T09:00", 2), ["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z"]);
  // 02:30 doesn't exist on 2026-03-08: that day it's 03:30, the next day 02:30 again.
  assert.deepEqual(take(daily, "2026-03-07T02:30", 3, tz), ["2026-03-07T02:30", "2026-03-08T03:30", "2026-03-09T02:30"]);
});

test("nextAfter, firstAtOrAfter, between", () => {
  const rule: Rule = { freq: "daily", interval: 1, end: { type: "count", count: 3 } };
  const a = "2026-10-07T09:00";
  const t = new Date("2026-10-08T09:00:00Z");
  assert.equal(firstAtOrAfter(rule, a, "UTC", t)?.toISOString(), "2026-10-08T09:00:00.000Z");
  assert.equal(nextAfter(rule, a, "UTC", t)?.toISOString(), "2026-10-09T09:00:00.000Z");
  assert.equal(nextAfter(rule, a, "UTC", new Date("2026-10-09T09:00:00Z")), null); // series over
  assert.deepEqual(
    between(rule, a, "UTC", new Date("2026-10-07T09:00:00Z"), new Date("2026-10-08T12:00:00Z")).map((d) => d.toISOString()),
    ["2026-10-07T09:00:00.000Z", "2026-10-08T09:00:00.000Z"],
  );
});

test("describe", () => {
  const a = "2026-10-07T09:00"; // a Wednesday, the 7th
  assert.equal(describe({ freq: "daily", interval: 1, end: never }, a), "Every day");
  assert.equal(describe({ freq: "weekly", interval: 1, weekdays: [0, 1, 2, 3, 4], end: never }, a), "Every weekday");
  assert.equal(
    describe({ freq: "weekly", interval: 2, weekdays: [0, 2], end: { type: "until", date: "2026-12-31" } }, a),
    "Every 2 weeks on Mon and Wed, until 31 Dec 2026",
  );
  assert.equal(describe({ freq: "monthly", interval: 1, monthly: { by: "weekday", nth: -1 }, end: never }, "2026-10-30T09:00"), "Every month on the last Friday");
  assert.equal(describe({ freq: "monthly", interval: 3, monthly: { by: "day" }, end: { type: "count", count: 4 } }, a), "Every 3 months on day 7, 4 times");
  assert.equal(describe({ freq: "yearly", interval: 1, end: never }, a), "Every year on 7 Oct");
});

test("ruleFromForm", () => {
  const f = { repeat: "custom", every: "2", unit: "week", weekdays: ["2", "0"], monthlyBy: "day", ends: "count", until: "", count: "5" };
  const a = "2026-10-07T09:00";
  assert.deepEqual(ruleFromForm(f, a), { rule: { freq: "weekly", interval: 2, weekdays: [0, 2], end: { type: "count", count: 5 } } });
  assert.deepEqual(ruleFromForm({ ...f, repeat: "none" }, a), { rule: null });
  assert.deepEqual(ruleFromForm({ ...f, repeat: "weekly" }, a), { rule: { freq: "weekly", interval: 1, weekdays: [2], end: never } });
  // The 30th is the 5th Friday -> "last Friday".
  assert.deepEqual(ruleFromForm({ ...f, unit: "month", monthlyBy: "weekday", ends: "never" }, "2026-10-30T09:00"), {
    rule: { freq: "monthly", interval: 2, monthly: { by: "weekday", nth: -1 }, end: never },
  });
  const err = (o: object) => (ruleFromForm({ ...f, ...o }, a) as { error: string }).error;
  assert.match(err({ every: "0" }), /1–99/);
  assert.match(err({ weekdays: [] }), /at least one day/);
  assert.match(err({ ends: "until", until: "2026-10-01" }), /before the start/);
  assert.match(err({ ends: "count", count: "501" }), /1–500/);
});
