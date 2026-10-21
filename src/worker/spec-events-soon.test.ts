// Behaviour tests from docs/expected-behaviour.md section 11: "Starts soon"
// notices (SN1–SN6) and the carried-over rule RC2 (daily email limit and
// suspended company) for notices. Written from the spec, not the code: a
// failure means one of them is wrong.
//
// Events are seeded with raw SQL through the owner pool, in 2031, and every
// worker call gets an explicit `now`, so a live worker never touches them.
// A "tick" runs what the worker runs each minute that matters here:
// dispatchDue (a date coming round) and then dispatchSoon.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import type { sendMail } from "@/lib/mail";
import { MEMBER_ROLE_ID } from "@/lib/permissions";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { deliverOne, dispatchDue, dispatchSoon } from "./delivery";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

let olga: string, alice: string, bob: string, carol: string;
const TEAM = () => `T-${s.companyId}`;
const emailOf = (id: string) => `${id}@${s.domain}`;
const MIN = 60_000;
const DAY = 86_400_000;
const DAILY = { freq: "daily", interval: 1, end: { type: "never" } };
const MEET = "https://meet.example.com/soon-xyz";

type Mail = Parameters<typeof sendMail>[0];
const capture = (box: Mail[]) => (async (m: Mail) => void box.push(m)) as unknown as typeof sendMail;

let n = 0;
type EventOpts = {
  title?: string;
  start: Date;
  anchorLocal: string;
  tz?: string;
  notifyBefore?: number[];
  channels?: string;
  status?: string;
  allDay?: boolean;
  duration?: number;
  recurrence?: object | null;
  guests?: string[];
};
// An event organised by olga, with the given guests (people).
async function event(o: EventOpts) {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status, time_zone, anchor_local,
       is_event, duration_minutes, all_day, location, meeting_url, notify_before, channels, recurrence)
     values ($1, $2, $3, $4, '', 'Olga', $5, $6, $7, $8, true, $9, $10, 'Room 2', $11, $12, $13, $14) returning id`,
    [
      s.companyId,
      `SN-${s.companyId.slice(0, 6)}-${n++}`,
      olga,
      o.title ?? "Planning",
      o.start,
      o.status ?? "scheduled",
      o.tz ?? "UTC",
      o.anchorLocal,
      o.duration ?? 60,
      o.allDay ?? false,
      MEET,
      `{${(o.notifyBefore ?? [10]).join(",")}}`,
      o.channels ?? "{email}",
      o.recurrence ? JSON.stringify(o.recurrence) : null,
    ],
  );
  for (const g of o.guests ?? [alice, bob]) await q("insert into reminder_targets values ($1, $2, 'user', $3)", [id, s.companyId, g]);
  return id as string;
}
const answer = (id: string, user: string, a: "yes" | "no" | "maybe") =>
  q(
    `insert into event_responses (reminder_id, user_id, company_id, answer) values ($1, $2, $3, $4)
     on conflict (reminder_id, user_id) do update set answer = excluded.answer`,
    [id, user, s.companyId, a],
  );
// One worker tick at `now`; returns the "starts soon" delivery ids it queued.
async function tick(now: Date) {
  await dispatchDue(async () => {}, s.companyId, now);
  const ids: string[] = [];
  await dispatchSoon(async (x) => void ids.push(...x), s.companyId, now);
  return ids;
}
type Soon = { id: string; channel: string; user_id: string; address: string; occurs_at: Date; before_minutes: number; status: string };
const soonOf = async (id: string) =>
  (await q(
    "select id, channel, user_id, address, occurs_at, before_minutes, status from deliveries where reminder_id = $1 and kind = 'soon' order by occurs_at, before_minutes desc, channel, user_id",
    [id],
  )) as Soon[];
const name = (u: string) => ({ [olga]: "olga", [alice]: "alice", [bob]: "bob", [carol]: "carol" })[u] ?? u;
// "who:channel:minutes" per notice, sorted.
const summary = (rows: Soon[]) => rows.map((r) => `${name(r.user_id)}:${r.channel}:${r.before_minutes}`).sort();

function fakeSlack() {
  const posts: { channel: string; text: string; blocks: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const json = (b: object) => new Response(JSON.stringify(b));
    const p = init.body as URLSearchParams;
    const method = url.split("/").pop();
    if (method === "users.lookupByEmail") return json({ ok: true, user: { id: `U-${p.get("email")}` } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: `D-${p.get("users")}` } });
    if (method === "chat.postMessage") {
      posts.push({ channel: p.get("channel")!, text: p.get("text")!, blocks: p.get("blocks") ?? "" });
      return json({ ok: true, channel: p.get("channel"), ts: "1.0" });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  return { f, posts };
}

before(async () => {
  await s.company();
  [olga, alice, bob, carol] = [await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] })];
  for (const [id, nm] of [[olga, "Olga"], [alice, "Alice"], [bob, "Bob"], [carol, "Carol"]]) await q(`update "user" set name = $2 where id = $1`, [id, nm]);
  await q("insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'WS', $3, 'UBOT')", [
    s.companyId,
    TEAM(),
    encrypt("xoxb-test"),
  ]);
});
after(async () => {
  await q("delete from event_responses where company_id = $1", [s.companyId]);
  await q("delete from deliveries where company_id = $1", [s.companyId]);
  await s.cleanup();
  await ownerDb.$client.end();
  await db.$client.end();
  await authDb.$client.end();
});

// SN1 changed 2026-10-21: the organiser (olga, who has no answer row) gets
// every notice too, on the event's channels; so does every case below.
// "By default" is the form's default (10 minutes ticked); that is a browser
// check. Here the event carries {10}, as the form saves it.
test("SN1: 10 minutes before, each guest who hasn't said No, and the organiser, gets 'Starts in 10 minutes' with the Join link, over the event's channels", async () => {
  const START = new Date("2031-03-03T10:00:00Z");
  const id = await event({ start: START, anchorLocal: "2031-03-03T10:00", notifyBefore: [10], channels: "{email,slack}", guests: [alice, bob, carol] });
  await answer(id, bob, "maybe");
  await answer(id, carol, "no");

  assert.deepEqual(await tick(new Date(START.getTime() - 11 * MIN)), [], "nothing 11 minutes before");
  assert.deepEqual(await soonOf(id), []);
  await tick(new Date(START.getTime() - 10 * MIN));
  const rows = await soonOf(id);
  assert.deepEqual(summary(rows), ["alice:email:10", "alice:slack:10", "bob:email:10", "bob:slack:10", "olga:email:10", "olga:slack:10"], "alice (no answer), bob (Maybe) and the organiser; not carol (No)");
  for (const r of rows) assert.equal(new Date(r.occurs_at).getTime(), START.getTime(), "occurs_at is the date's start");
  for (const r of rows.filter((r) => r.channel === "email")) assert.equal(r.address, emailOf(r.user_id));

  // The message. deliverOne takes no clock, so the text is checked on a copy
  // that starts 10 minutes from the real now and is dispatched and delivered
  // at once (the 2031 one above checks the timing).
  const soon = new Date(Math.ceil((Date.now() + 10 * MIN) / MIN) * MIN);
  const live = await event({ start: soon, anchorLocal: soon.toISOString().slice(0, 16), notifyBefore: [10], channels: "{email,slack}", guests: [alice, bob] });
  await tick(new Date(soon.getTime() - 10 * MIN));
  const liveRows = await soonOf(live);
  assert.deepEqual(summary(liveRows), ["alice:email:10", "alice:slack:10", "bob:email:10", "bob:slack:10", "olga:email:10", "olga:slack:10"]);
  const box: Mail[] = [];
  assert.equal(await deliverOne(liveRows.find((r) => r.channel === "email" && r.user_id === alice)!.id, capture(box)), "sent");
  assert.equal(box.length, 1);
  assert.equal(box[0].to, emailOf(alice));
  assert.match(`${box[0].subject}\n${box[0].text}`, /starts in 10 minutes/i, "says 'Starts in 10 minutes'");
  assert.match(`${box[0].subject}\n${box[0].text}`, /Planning/, "names the event");
  const links = box[0].links ?? [];
  assert.ok(links.some((l) => l.url === MEET && /join/i.test(l.label)), `a Join link: ${JSON.stringify(links)}`);

  // The Slack DM.
  const sl = fakeSlack();
  assert.equal(await deliverOne(liveRows.find((r) => r.channel === "slack" && r.user_id === bob)!.id, undefined, sl.f), "sent");
  assert.equal(sl.posts.length, 1);
  assert.match(sl.posts[0].text, /starts in 10 minutes/i);
  assert.ok(`${sl.posts[0].text}${sl.posts[0].blocks}`.includes(MEET), "the Slack message carries the Join link");

  // The organiser's own email and Slack DM say the same.
  const orgBox: Mail[] = [];
  assert.equal(await deliverOne(liveRows.find((r) => r.channel === "email" && r.user_id === olga)!.id, capture(orgBox)), "sent");
  assert.equal(orgBox.length, 1);
  assert.equal(orgBox[0].to, emailOf(olga));
  assert.match(`${orgBox[0].subject}\n${orgBox[0].text}`, /starts in 10 minutes/i, "the organiser's email says 'Starts in 10 minutes'");
  assert.ok((orgBox[0].links ?? []).some((l) => l.url === MEET && /join/i.test(l.label)), "the organiser's email has the Join link");
  const orgSl = fakeSlack();
  assert.equal(await deliverOne(liveRows.find((r) => r.channel === "slack" && r.user_id === olga)!.id, undefined, orgSl.f), "sent");
  assert.equal(orgSl.posts.length, 1);
  assert.match(orgSl.posts[0].text, /starts in 10 minutes/i);

  // The organiser also listed as a guest: still one notice per channel.
  const selfInvited = await event({ start: START, anchorLocal: "2031-03-03T10:00", notifyBefore: [10], channels: "{email}", guests: [alice, olga] });
  await tick(new Date(START.getTime() - 10 * MIN));
  assert.deepEqual(summary(await soonOf(selfInvited)), ["alice:email:10", "olga:email:10"]);

  // Channels followed: an email-only event gets no Slack notices.
  const emailOnly = await event({ start: START, anchorLocal: "2031-03-03T10:00", notifyBefore: [10], channels: "{email}", guests: [alice] });
  await tick(new Date(START.getTime() - 10 * MIN));
  assert.deepEqual(summary(await soonOf(emailOnly)), ["alice:email:10", "olga:email:10"]);
});

test("SN2: several notices (1 day and 10 minutes): each sent once per date, in time order; a changed setting is followed", async () => {
  const START = new Date("2031-04-07T10:00:00Z");
  const at = (min: number) => new Date(START.getTime() - min * MIN);
  const id = await event({ start: START, anchorLocal: "2031-04-07T10:00", notifyBefore: [1440, 10], guests: [alice] });

  await tick(at(1441));
  assert.deepEqual(summary(await soonOf(id)), [], "nothing before the first one is due");
  await tick(at(1440));
  assert.deepEqual(summary(await soonOf(id)), ["alice:email:1440", "olga:email:1440"], "the day-before ones first, alone");
  await tick(at(1440));
  await tick(at(600));
  assert.deepEqual(summary(await soonOf(id)), ["alice:email:1440", "olga:email:1440"], "not again on later runs");
  await tick(at(10));
  await tick(at(10));
  await tick(at(5));
  assert.deepEqual(summary(await soonOf(id)), ["alice:email:10", "alice:email:1440", "olga:email:10", "olga:email:1440"], "then the 10-minute ones, once");

  // Sent in time order: the 1-day one goes out before the 10-minute one.
  const rows = await soonOf(id);
  const box: Mail[] = [];
  for (const r of rows) assert.equal(await deliverOne(r.id, capture(box)), "sent");
  assert.equal(await deliverOne(rows[0].id, capture(box)), "skipped", "a retry doesn't send twice");
  assert.equal(box.length, 4);

  // The organiser changes it: from {10} to 1 hour and 10 minutes before the date is due.
  const START2 = new Date("2031-04-08T10:00:00Z");
  const changed = await event({ start: START2, anchorLocal: "2031-04-08T10:00", notifyBefore: [10], guests: [alice] });
  await tick(new Date(START2.getTime() - 2 * 60 * MIN));
  await q("update reminders set notify_before = '{60,10}' where id = $1", [changed]);
  await tick(new Date(START2.getTime() - 60 * MIN));
  assert.deepEqual(summary(await soonOf(changed)), ["alice:email:60", "olga:email:60"], "the added 1-hour notice goes");
  await tick(new Date(START2.getTime() - 10 * MIN));
  assert.deepEqual(summary(await soonOf(changed)), ["alice:email:10", "alice:email:60", "olga:email:10", "olga:email:60"]);
});

test("SN3: 'None' sends no notices before", async () => {
  const START = new Date("2031-05-05T10:00:00Z");
  const id = await event({ start: START, anchorLocal: "2031-05-05T10:00", notifyBefore: [], channels: "{email,slack}" });
  for (const min of [1440, 60, 30, 10, 1, 0]) await tick(new Date(START.getTime() - min * MIN));
  assert.deepEqual(await soonOf(id), []);
});

test("SN4: a repeating event gets its notices before every date", async () => {
  const START = new Date("2031-06-02T10:00:00Z");
  const id = await event({ start: START, anchorLocal: "2031-06-02T10:00", notifyBefore: [10], recurrence: DAILY, duration: 30, guests: [alice, bob] });
  for (let d = 0; d < 3; d++) {
    const date = START.getTime() + d * DAY;
    await tick(new Date(date - 11 * MIN));
    await tick(new Date(date - 10 * MIN));
    await tick(new Date(date - 5 * MIN));
    await tick(new Date(date)); // the date comes round
    await tick(new Date(date + 30 * MIN));
  }
  const rows = await soonOf(id);
  const byDate = new Map<number, string[]>();
  for (const r of rows) byDate.set(new Date(r.occurs_at).getTime(), [...(byDate.get(new Date(r.occurs_at).getTime()) ?? []), name(r.user_id)]);
  assert.deepEqual(
    [...byDate.entries()].map(([t, who]) => [new Date(t).toISOString(), who.sort()]),
    [0, 1, 2].map((d) => [new Date(START.getTime() + d * DAY).toISOString(), ["alice", "bob", "olga"]]),
    "each guest and the organiser once before each of the three dates",
  );
  assert.ok(rows.every((r) => r.before_minutes === 10));
});

// SN5 is answered as written: an all-day notice goes at 09:00 company time
// that day, minus the chosen time. The event's own zone is the company's here.
test("SN5: an all-day event's notices count back from 09:00 company time that day", async () => {
  const [{ time_zone: oldTz }] = await q("select time_zone from companies where id = $1", [s.companyId]);
  await q("update companies set time_zone = 'Asia/Dubai' where id = $1", [s.companyId]); // UTC+4, no DST
  try {
    // 12 Mar 2031 all day in Dubai: midnight local is 11 Mar 20:00Z; 09:00 local is 12 Mar 05:00Z.
    const MIDNIGHT = new Date("2031-03-11T20:00:00Z");
    const NINE = new Date("2031-03-12T05:00:00Z");
    const id = await event({ start: MIDNIGHT, anchorLocal: "2031-03-12T00:00", tz: "Asia/Dubai", allDay: true, duration: 1440, notifyBefore: [1440, 10], guests: [alice] });

    // Ticks run forward in time. 1 day before midnight (10 Mar 20:00Z) is too early.
    await tick(new Date(MIDNIGHT.getTime() - 1440 * MIN));
    assert.deepEqual(summary(await soonOf(id)), [], "the 1-day one isn't counted from midnight");
    await tick(new Date(NINE.getTime() - 1441 * MIN));
    assert.deepEqual(summary(await soonOf(id)), [], "the day-before one isn't due before 09:00 the day before");
    await tick(new Date(NINE.getTime() - 1440 * MIN));
    assert.deepEqual(summary(await soonOf(id)), ["alice:email:1440", "olga:email:1440"], "09:00 the day before (1 day before 09:00)");
    // Counting back from midnight would send the 10-minute one at 19:50Z on the 11th: it must not.
    await tick(new Date(MIDNIGHT.getTime() - 10 * MIN));
    assert.deepEqual(summary(await soonOf(id)), ["alice:email:1440", "olga:email:1440"], "the 10-minute one isn't counted from midnight");
    await tick(new Date(NINE.getTime() - 11 * MIN));
    assert.deepEqual(summary(await soonOf(id)), ["alice:email:1440", "olga:email:1440"], "the 10-minute one isn't due before 08:50");
    await tick(new Date(NINE.getTime() - 10 * MIN));
    assert.deepEqual(summary(await soonOf(id)), ["alice:email:10", "alice:email:1440", "olga:email:10", "olga:email:1440"], "08:50 company time that day");
  } finally {
    await q("update companies set time_zone = $2 where id = $1", [s.companyId, oldTz]);
  }
});

test("SN6: nothing for a skipped date, a cancelled or deleted event, or a guest who said No", async (t) => {
  await t.test("a skipped date of a series", async () => {
    const START = new Date("2031-07-07T10:00:00Z");
    const id = await event({ start: START, anchorLocal: "2031-07-07T10:00", notifyBefore: [10], recurrence: DAILY, duration: 30, guests: [alice] });
    const skipped = new Date(START.getTime() + DAY);
    await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, $3, 'skipped')", [s.companyId, id, skipped]);
    for (let d = 0; d < 3; d++) {
      const date = START.getTime() + d * DAY;
      await tick(new Date(date - 10 * MIN));
      await tick(new Date(date));
    }
    const got = (await soonOf(id)).map((r) => `${new Date(r.occurs_at).toISOString()} ${name(r.user_id)}`).sort();
    assert.ok(!got.some((x) => x.startsWith(skipped.toISOString())), `no notice for the skipped date: ${JSON.stringify(got)}`);
    const other = [START, new Date(START.getTime() + 2 * DAY)].map((d) => d.toISOString());
    assert.deepEqual(got, other.flatMap((d) => [`${d} alice`, `${d} olga`]), "the other dates still get theirs (guest and organiser)");
  });

  await t.test("cancelled", async () => {
    const START = new Date("2031-07-14T10:00:00Z");
    const id = await event({ start: START, anchorLocal: "2031-07-14T10:00", status: "cancelled", notifyBefore: [10, 60] });
    await tick(new Date(START.getTime() - 60 * MIN));
    await tick(new Date(START.getTime() - 10 * MIN));
    assert.deepEqual(await soonOf(id), []);
  });

  await t.test("deleted", async () => {
    const START = new Date("2031-07-15T10:00:00Z");
    const id = await event({ start: START, anchorLocal: "2031-07-15T10:00", notifyBefore: [10, 60] });
    await q("update reminders set deleted_at = now(), status = 'cancelled' where id = $1", [id]);
    await tick(new Date(START.getTime() - 60 * MIN));
    await tick(new Date(START.getTime() - 10 * MIN));
    assert.deepEqual(await soonOf(id), []);
  });

  await t.test("the guest said No (others still told)", async () => {
    const START = new Date("2031-07-16T10:00:00Z");
    const id = await event({ start: START, anchorLocal: "2031-07-16T10:00", notifyBefore: [60, 10], guests: [alice, bob] });
    await answer(id, bob, "no");
    await tick(new Date(START.getTime() - 60 * MIN));
    assert.deepEqual(summary(await soonOf(id)), ["alice:email:60", "olga:email:60"], "bob said No; alice and the organiser are told");
    // Alice changes to No between the two notices: no 10-minute one for her.
    await answer(id, alice, "no");
    await tick(new Date(START.getTime() - 10 * MIN));
    assert.deepEqual(summary(await soonOf(id)), ["alice:email:60", "olga:email:10", "olga:email:60"], "the organiser still gets the 10-minute one");
  });

  // Literal reading of "Nothing": a notice already queued isn't sent once the
  // event is cancelled or deleted, or the guest says No, before it goes out.
  await t.test("queued, then cancelled / deleted / answered No before sending: not sent", async () => {
    const START = new Date("2031-07-17T10:00:00Z");
    const mk = () => event({ start: START, anchorLocal: "2031-07-17T10:00", notifyBefore: [10], guests: [alice] });
    const [c, d, no] = [await mk(), await mk(), await mk()];
    await tick(new Date(START.getTime() - 10 * MIN));
    await q("update reminders set status = 'cancelled' where id = $1", [c]);
    await q("update reminders set deleted_at = now(), status = 'cancelled' where id = $1", [d]);
    await answer(no, alice, "no");
    // Cancelled / deleted: nobody's goes (guest or organiser). Alice said No:
    // hers doesn't go; the organiser's still does (she can't say No).
    const outcome: Record<string, string> = {};
    for (const [label, id] of [["cancelled", c], ["deleted", d], ["said No", no]] as const) {
      const rows = await soonOf(id);
      assert.deepEqual(summary(rows), ["alice:email:10", "olga:email:10"], `${label}: queued before the change`);
      for (const row of rows) {
        const box: Mail[] = [];
        const r = await deliverOne(row.id, capture(box));
        outcome[`${label} ${name(row.user_id)}`] = `${r}, ${box.length} email(s)`;
      }
    }
    const all = JSON.stringify(outcome);
    for (const key of ["cancelled alice", "cancelled olga", "deleted alice", "deleted olga", "said No alice"])
      assert.doesNotMatch(outcome[key], /^sent|, [1-9]/, `${key}: not sent (all: ${all})`);
    assert.equal(outcome["said No olga"], "sent, 1 email(s)", `said No olga: the organiser's still goes (all: ${all})`);
  });
});

test("RC2: notices count toward the daily email limit and wait while it's reached or the company is suspended", async (t) => {
  const sentToday = async () =>
    Number(
      (await q("select count(*) from deliveries where company_id = $1 and channel = 'email' and status = 'sent' and sent_at > now() - interval '24 hours'", [s.companyId]))[0]
        .count,
    );

  await t.test("daily email limit: held, then sent once there is room", async () => {
    const START = new Date("2031-08-04T10:00:00Z");
    const dan = await s.user({ roles: [MEMBER_ROLE_ID] });
    const id = await event({ start: START, anchorLocal: "2031-08-04T10:00", notifyBefore: [10], guests: [alice, bob, dan] });
    await tick(new Date(START.getTime() - 10 * MIN));
    const rows = await soonOf(id);
    assert.equal(rows.length, 4, "three guests and the organiser");
    const before = await sentToday();
    await q("update companies set daily_email_limit = $2 where id = $1", [s.companyId, before + 1]); // room for one more
    try {
      const results: string[] = [];
      for (const r of rows) results.push(await deliverOne(r.id, capture([])));
      assert.deepEqual(results.sort(), ["held", "held", "held", "sent"]);
      assert.equal(await sentToday(), before + 1, "the sent notice counts toward the limit");
      const held = await q("select attempts from deliveries where reminder_id = $1 and kind = 'soon' and status = 'queued'", [id]);
      assert.equal(held.length, 3, "the other three wait (still queued)");
      assert.ok(held.every((h) => h.attempts === 0), "waiting uses no attempt");

      // A reminder email now waits too: the notice used the last room.
      const [{ id: rid }] = await q(
        `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status, time_zone, anchor_local, channels)
         values ($1, $2, $3, 'Plain reminder', '', 'Olga', '2031-08-04T12:00:00Z', 'scheduled', 'UTC', '2031-08-04T12:00', '{email}') returning id`,
        [s.companyId, `RC2-${randomUUID().slice(0, 6)}`, olga],
      );
      await q("insert into reminder_targets values ($1, $2, 'user', $3)", [rid, s.companyId, carol]);
      await dispatchDue(async () => {}, s.companyId, new Date("2031-08-04T12:00:00Z"));
      const [rem] = await q("select id from deliveries where reminder_id = $1", [rid]);
      assert.ok(rem, "the reminder email was queued");
      assert.equal(await deliverOne(rem.id, capture([])), "held", "the limit is shared with reminder emails");

      // Room again: the held notices go out, once each.
      await q("update companies set daily_email_limit = 2000 where id = $1", [s.companyId]);
      const box: Mail[] = [];
      for (const r of rows) await deliverOne(r.id, capture(box));
      assert.equal(box.length, 3);
      assert.deepEqual((await soonOf(id)).map((r) => r.status), ["sent", "sent", "sent", "sent"]);
    } finally {
      await q("update companies set daily_email_limit = 2000 where id = $1", [s.companyId]);
    }
  });

  await t.test("suspended company: notices wait, then go once it's lifted", async () => {
    const START = new Date("2031-08-05T10:00:00Z");
    const id = await event({ start: START, anchorLocal: "2031-08-05T10:00", notifyBefore: [10], guests: [alice] });
    await q("update companies set suspended_at = now() where id = $1", [s.companyId]);
    try {
      await tick(new Date(START.getTime() - 10 * MIN));
      await tick(new Date(START.getTime() - 5 * MIN));
      assert.deepEqual(await soonOf(id), [], "nothing queued while suspended");
    } finally {
      await q("update companies set suspended_at = null where id = $1", [s.companyId]);
    }
    await tick(new Date(START.getTime() - 5 * MIN));
    assert.deepEqual(summary(await soonOf(id)), ["alice:email:10", "olga:email:10"], "it waited and goes once the suspension is lifted");
  });
});
