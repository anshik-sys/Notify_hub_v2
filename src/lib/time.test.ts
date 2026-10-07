import assert from "node:assert/strict";
import { test } from "node:test";
import { toLocalInput, zonedToUtc } from "./time";

const iso = (local: string, tz: string) => zonedToUtc(local, tz)?.toISOString();

test("zonedToUtc", () => {
  assert.equal(iso("2026-10-08T09:00", "UTC"), "2026-10-08T09:00:00.000Z");
  assert.equal(iso("2026-10-08T09:00", "Asia/Kolkata"), "2026-10-08T03:30:00.000Z");
  assert.equal(iso("2026-07-01T09:00", "America/New_York"), "2026-07-01T13:00:00.000Z"); // EDT
  assert.equal(iso("2026-01-15T09:00", "America/New_York"), "2026-01-15T14:00:00.000Z"); // EST
  // DST gap: 02:30 doesn't exist on 2026-03-08 in New York -> 03:30 EDT.
  assert.equal(iso("2026-03-08T02:30", "America/New_York"), "2026-03-08T07:30:00.000Z");
  // DST overlap: 01:30 happens twice on 2026-11-01 -> the earlier (EDT) one.
  assert.equal(iso("2026-11-01T01:30", "America/New_York"), "2026-11-01T05:30:00.000Z");
  assert.equal(zonedToUtc("tomorrow", "UTC"), null);
});

test("toLocalInput round-trips", () => {
  for (const [local, tz] of [
    ["2026-10-08T09:00", "Asia/Kolkata"],
    ["2026-11-01T01:30", "America/New_York"],
    ["2026-12-31T23:59", "Pacific/Auckland"],
  ])
    assert.equal(toLocalInput(zonedToUtc(local, tz)!, tz), local);
});
