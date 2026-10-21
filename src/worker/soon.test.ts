import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { deliverOne, dispatchSoon } from "./delivery";

// PRD 14.3 "starts soon" notices from the worker (SN1-SN6).
const s = seeder();
let creator: string, alice: string, bob: string, ops: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const START = new Date("2031-03-03T10:00:00Z");
const before_ = (min: number) => new Date(START.getTime() - min * 60_000);
let n = 0;
async function event(set = "") {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_event, duration_minutes,
       meeting_url, notify_before, channels)
     values ($1, $2, $3, 'Planning', 'Olga', $4, 'scheduled', 'UTC', '2031-03-03T10:00', true, 60, 'https://meet.example.com/abc', '{10,1440}', '{email}') returning id`,
    [s.companyId, `S-${s.companyId.slice(0, 6)}-${n++}`, creator, START],
  );
  await q("insert into reminder_targets values ($1, $2, 'department', $3)", [id, s.companyId, ops]);
  if (set) await q(`update reminders set ${set} where id = $1`, [id]);
  return id as string;
}
const dispatch = async (now: Date) => {
  const ids: string[] = [];
  await dispatchSoon(async (x) => void ids.push(...x), s.companyId, now);
  return ids;
};
const notices = async (id: string) =>
  (await q("select user_id, before_minutes from deliveries where reminder_id = $1 and kind = 'soon'", [id]))
    .map((r) => `${r.user_id === alice ? "alice" : r.user_id === bob ? "bob" : r.user_id}:${r.before_minutes}`)
    .sort();

before(async () => {
  await s.company();
  [creator, alice, bob] = [await s.user(), await s.user(), await s.user()];
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  for (const u of [creator, alice, bob]) await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, u]);
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
});

test("1 day and 10 minutes: each once, in order, to guests only (not the organiser)", async () => {
  const id = await event();
  assert.deepEqual(await dispatch(before_(1441)), []);
  assert.equal((await dispatch(before_(1440))).length, 2);
  assert.deepEqual(await dispatch(before_(600)), []); // the day-before one isn't sent again
  assert.equal((await dispatch(before_(10))).length, 2);
  assert.deepEqual(await dispatch(before_(5)), []);
  assert.deepEqual(await notices(id), ["alice:10", "alice:1440", "bob:10", "bob:1440"]);
});

test("created late: only the nearest notice, no stale 'in 1 day'", async () => {
  const id = await event();
  await dispatch(before_(5));
  assert.deepEqual(await notices(id), ["alice:10", "bob:10"]);
});

test("nothing for a guest who said No, nor for cancelled, deleted, paused or 'none'", async () => {
  const id = await event();
  await q("insert into event_responses (reminder_id, user_id, company_id, answer) values ($1, $2, $3, 'no')", [id, bob, s.companyId]);
  const cancelled = await event("status = 'cancelled'");
  const deleted = await event("deleted_at = now()");
  const paused = await event("status = 'paused'");
  const none = await event("notify_before = '{}'");
  await dispatch(before_(10));
  assert.deepEqual(await notices(id), ["alice:10"]);
  for (const x of [cancelled, deleted, paused, none]) assert.deepEqual(await notices(x), []);
});

test("a series: before every date, but not a skipped one", async () => {
  const id = await event(`recurrence = '{"freq":"daily","interval":1,"end":{"type":"never"}}', notify_before = '{10}'`);
  await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, $3, 'skipped')", [
    s.companyId,
    id,
    new Date(START.getTime() + 86_400_000),
  ]);
  await dispatch(before_(10));
  await dispatch(new Date(START.getTime() + 86_400_000 - 10 * 60_000)); // the skipped day
  await dispatch(new Date(START.getTime() + 2 * 86_400_000 - 10 * 60_000));
  const dates = (await q("select distinct occurs_at from deliveries where reminder_id = $1 and kind = 'soon' order by 1", [id])).map((r) => r.occurs_at.toISOString());
  assert.deepEqual(dates, [START.toISOString(), new Date(START.getTime() + 2 * 86_400_000).toISOString()]);
});

test("all day: counts back from 09:00 that day", async () => {
  const id = await event("all_day = true, duration_minutes = 1440, send_at = '2031-03-03T00:00Z', status = 'sent', notify_before = '{10}'");
  // (Its own notices only: earlier tests' events are due at other times.)
  await dispatch(new Date("2031-03-03T08:49:00Z"));
  assert.deepEqual(await notices(id), []);
  await dispatch(new Date("2031-03-03T08:50:00Z"));
  assert.deepEqual(await notices(id), ["alice:10", "bob:10"]);
});

test("the email: 'Starts in 10 minutes' with Join", async () => {
  const id = await event("notify_before = '{10}'");
  const [d] = await dispatch(before_(10));
  const sent: { subject: string; links?: { label: string; url: string }[] }[] = [];
  // The wording uses the real clock; this checks the shape, not the minutes.
  assert.equal(await deliverOne(d, async (m) => void sent.push(m) as never), "sent");
  assert.match(sent[0].subject, /^Starts in .+: Planning$/);
  assert.deepEqual(sent[0].links!.at(-1), { label: "Join the meeting", url: "https://meet.example.com/abc" });
  assert.equal((await q("select status from deliveries where reminder_id = $1 and kind = 'soon' and status = 'sent'", [id])).length, 1);
});
