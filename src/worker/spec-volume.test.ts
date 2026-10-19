// Spec tests for docs/expected-behaviour.md section 7 ("Volume alert looks
// ahead", V1–V14), written from the spec, not the implementation.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Rule } from "@/lib/recurrence";
import { lockPlatformSettings, seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { upcomingVolumeAlerts, volumeAlerts } from "./volume-alert";

type Seeder = ReturnType<typeof seeder>;
type Mail = { to: string; subject: string; text: string; links?: unknown };

const OWNERS = ["owner1@spec-volume.test", "owner2@spec-volume.test"];
const savedOwners = process.env.PLATFORM_OWNER_EMAILS;
const seeders: Seeder[] = [];
let savedThreshold: number | null = null;
let admin: Seeder;
const q = async (sql: string, params: unknown[] = []) => (await admin.owner.query(sql, params)).rows;

// A fixed "now" far in the future, so a locally running worker never sees
// these reminders as due. 2040-03-01 is a Thursday.
const NOW = new Date("2040-03-01T00:00:00Z");
const DAY = 86_400_000;
const dayIso = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString().slice(0, 10); // day NOW + n
const at = (n: number, hhmm = "09:00") => `${dayIso(n)}T${hhmm}`;

let release: () => Promise<void>;
before(async () => {
  release = await lockPlatformSettings();
  admin = seeder();
  seeders.push(admin);
  savedThreshold = (await q("select daily_volume_alert from platform_settings where id = 1"))[0]?.daily_volume_alert ?? null;
  process.env.PLATFORM_OWNER_EMAILS = OWNERS.join(", ");
});

after(async () => {
  await q("insert into platform_settings (id, daily_volume_alert) values (1, $1) on conflict (id) do update set daily_volume_alert = $1", [savedThreshold]);
  await release();
  for (const s of seeders) await s.owner.query("delete from platform_alerts where company_id = $1", [s.companyId]);
  if (savedOwners === undefined) delete process.env.PLATFORM_OWNER_EMAILS;
  else process.env.PLATFORM_OWNER_EMAILS = savedOwners;
  for (const s of seeders) {
    await s.owner.query("delete from deliveries where company_id = $1", [s.companyId]);
    await s.owner.query("delete from group_members where company_id = $1", [s.companyId]);
    await s.cleanup();
  }
  await ownerDb.$client.end();
});

const threshold = (n: number | null) =>
  q("insert into platform_settings (id, daily_volume_alert) values (1, $1) on conflict (id) do update set daily_volume_alert = $1", [n]);

async function company(name = `Spec Volume ${Math.random().toString(36).slice(2, 8)}`) {
  const s = seeder();
  seeders.push(s);
  await s.company();
  await s.owner.query("update companies set name = $2 where id = $1", [s.companyId, name]);
  const creator = await s.user();
  return { s, name, creator };
}

type Target = ["user" | "department" | "group" | "company" | "email" | "slack_channel", string | null];
async function reminder(
  c: { s: Seeder; creator: string },
  o: {
    title: string;
    at: string; // local (UTC) anchor / send time
    targets: Target[];
    status?: string;
    channels?: string[];
    recurrence?: Rule | null;
    deleted?: boolean;
  },
) {
  const [{ id }] = (
    await c.s.owner.query(
      `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, channels, recurrence, deleted_at)
       values ($1, $2, $3, $4, 'S', $5, $6, 'UTC', $7, $8, $9, $10) returning id`,
      [
        c.s.companyId,
        `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        c.creator,
        o.title,
        `${o.at}:00Z`,
        o.status ?? "scheduled",
        o.at,
        o.channels ?? ["email"],
        o.recurrence ? JSON.stringify(o.recurrence) : null,
        o.deleted ? new Date() : null,
      ],
    )
  ).rows;
  for (const [kind, ref] of o.targets)
    await c.s.owner.query("insert into reminder_targets (reminder_id, company_id, kind, ref) values ($1, $2, $3, $4)", [id, c.s.companyId, kind, ref]);
  return id as string;
}

const outside = (n: number, tag = "x"): Target[] => Array.from({ length: n }, (_, i) => ["email", `${tag}${i}-${Math.random().toString(36).slice(2, 7)}@outside.test`]);

function capture() {
  const mails: Mail[] = [];
  const send = (async (m: Mail) => void mails.push(m)) as never;
  return { mails, send, all: () => mails.map((m) => JSON.stringify(m)).join("\n") };
}

// The day may be written several ways; accept the common ones.
function mentionsDay(text: string, iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return [iso, `${day} ${mon}`, `${mon} ${day}`].some((f) => text.includes(f)) || new RegExp(`\\b${day} ${mon}|${mon}[a-z]* ${day}\\b`).test(text);
}

const upcomingRows = async (companyId: string) =>
  (await q("select on_date::text as d from platform_alerts where company_id = $1 and kind = 'upcoming' order by on_date", [companyId])).map((r) => r.d as string);

test("V1: threshold blank: no look-ahead alerts at all", async () => {
  const c = await company();
  await reminder(c, { title: "Huge", at: at(3), targets: outside(20) });
  await threshold(null);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 0, "no busy days alerted with a blank threshold");
  assert.equal(m.mails.length, 0, "no email sent with a blank threshold");
  assert.deepEqual(await upcomingRows(c.s.companyId), []);
});

test("V2: a one-time reminder in 3 days over the threshold: one email per owner naming company, day and count", async () => {
  const c = await company();
  await reminder(c, { title: "All hands", at: at(3), targets: outside(6) });
  await threshold(5);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 1, "one busy day alerted");
  assert.deepEqual(m.mails.map((x) => x.to).sort(), [...OWNERS].sort(), "each platform owner gets exactly one email");
  const text = JSON.stringify(m.mails[0]);
  assert.ok(text.includes(c.name), `email names the company: ${text}`);
  assert.ok(mentionsDay(text, dayIso(3)), `email names the day ${dayIso(3)}: ${text}`);
  assert.match(text, /\b6\b/, "email gives the estimated count (6)");
});

test("V3: several reminders on the same day add up over the threshold", async () => {
  const c = await company();
  for (const t of ["A", "B", "C"]) await reminder(c, { title: `Part ${t}`, at: at(4, `1${t.charCodeAt(0) - 65}:00`), targets: outside(2) });
  await threshold(5);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 1, "the day's total (6) is over 5, so it's alerted");
  assert.ok(mentionsDay(m.all(), dayIso(4)), "names the day");
  assert.match(m.all(), /\b6\b/, "gives the day's total of 6");
});

test("V4: a daily repeat under the threshold plus a one-time on the same day: counted per occurrence per day", async () => {
  const c = await company();
  const daily: Rule = { freq: "daily", interval: 1, end: { type: "never" } };
  await reminder(c, { title: "Daily standup", at: at(0, "09:00"), targets: outside(3), recurrence: daily });
  await reminder(c, { title: "One-off", at: at(3, "15:00"), targets: outside(2) });
  await threshold(4);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 1, "only day 3 (3 + 2 = 5) is over 4; the other days have 3");
  assert.deepEqual(await upcomingRows(c.s.companyId), [dayIso(3)]);
  assert.match(m.all(), /\b5\b/, "the day's estimate is 5");
});

test("V5: exactly the threshold is not alerted", async () => {
  const c = await company();
  await reminder(c, { title: "Exact", at: at(2), targets: outside(5) });
  await threshold(5);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 0, "5 is not more than 5");
  assert.equal(m.mails.length, 0);
  await threshold(4);
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 1, "control: 5 is more than 4");
});

test("V6: a busy day 8+ days away isn't alerted until it comes within 7 days", async () => {
  const c = await company();
  await reminder(c, { title: "Far away", at: at(9), targets: outside(6) });
  await threshold(5);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 0, "9 days away: not yet");
  assert.equal(m.mails.length, 0);
  assert.equal(await upcomingVolumeAlerts(new Date(NOW.getTime() + 5 * DAY), c.s.companyId, m.send), 1, "4 days away: alerted");
  assert.ok(mentionsDay(m.all(), dayIso(9)));
});

test("V7: the next hour or next day doesn't repeat the alert for the same busy day", async () => {
  const c = await company();
  await reminder(c, { title: "Big", at: at(4), targets: outside(6) });
  await threshold(5);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 1);
  const sent = m.mails.length;
  assert.equal(await upcomingVolumeAlerts(new Date(NOW.getTime() + 3_600_000), c.s.companyId, m.send), 0, "an hour later: not repeated");
  assert.equal(await upcomingVolumeAlerts(new Date(NOW.getTime() + DAY), c.s.companyId, m.send), 0, "a day later: not repeated");
  assert.equal(m.mails.length, sent, "no further emails");
});

test("V8: a second busy day for the same company gets its own alert", async () => {
  const c = await company();
  await reminder(c, { title: "First busy", at: at(3), targets: outside(6) });
  await threshold(5);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 1);
  await reminder(c, { title: "Second busy", at: at(5), targets: outside(6) });
  const before = m.mails.length;
  assert.equal(await upcomingVolumeAlerts(new Date(NOW.getTime() + 3_600_000), c.s.companyId, m.send), 1, "the second day is alerted too");
  assert.ok(m.mails.length > before, "a new email is sent");
  assert.ok(mentionsDay(m.mails.slice(before).map((x) => JSON.stringify(x)).join(), dayIso(5)), "the new email names the second day");
  assert.deepEqual(await upcomingRows(c.s.companyId), [dayIso(3), dayIso(5)]);
});

test("V9: Slack-only, paused, waiting-for-approval, cancelled, deleted and sent reminders aren't counted", async () => {
  const c = await company();
  const users: Target[] = [];
  for (let i = 0; i < 3; i++) users.push(["user", await c.s.user()]);
  await reminder(c, { title: "Slack only", at: at(3), targets: [...users, ["slack_channel", "C123"]], channels: ["slack"] });
  await reminder(c, { title: "Paused", at: at(3), targets: outside(3), status: "paused" });
  await reminder(c, { title: "Waiting", at: at(3), targets: outside(3), status: "pending_approval" });
  await reminder(c, { title: "Rejected", at: at(3), targets: outside(3), status: "rejected" });
  await reminder(c, { title: "Cancelled", at: at(3), targets: outside(3), status: "cancelled" });
  await reminder(c, { title: "Deleted", at: at(3), targets: outside(3), status: "cancelled", deleted: true });
  await reminder(c, { title: "Already sent", at: at(3), targets: outside(3), status: "sent" });
  await reminder(c, { title: "Counted", at: at(3), targets: outside(2) });
  await threshold(2);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 0, "only the 2 emails of the scheduled email reminder count");
  assert.equal(m.mails.length, 0);
  await threshold(1);
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 1, "control: the scheduled one (2) is over 1");
});

test("V10: deactivated people and unsubscribed outside addresses aren't counted", async () => {
  const c = await company();
  // The creator plus two more are active; one is deactivated.
  const u2 = await c.s.user();
  const u3 = await c.s.user();
  const gone = await c.s.user();
  await c.s.owner.query("update \"user\" set deactivated_at = now() where id = $1", [gone]);
  const unsub = `unsub-${Math.random().toString(36).slice(2, 7)}@outside.test`;
  await c.s.owner.query("insert into email_suppressions (company_id, email) values ($1, $2)", [c.s.companyId, unsub]);
  const rid = await reminder(c, { title: "Everyone", at: at(3), targets: [["company", null], ["email", "keep@outside.test"], ["email", unsub]] });
  // Expected: 3 active people + 1 outside = 4.
  await threshold(4);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 0, "4 (not 6): deactivated and unsubscribed aren't counted");
  await threshold(3);
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 1, "control: 4 is over 3");
  assert.match(m.all(), /\b4\b/, "the estimate is 4");

  // One email per recipient: someone reached through several targets counts once.
  await q("delete from platform_alerts where company_id = $1", [c.s.companyId]);
  const [{ id: dept }] = (await c.s.owner.query("insert into departments (company_id, name) values ($1, 'Ops') returning id", [c.s.companyId])).rows;
  await c.s.owner.query("insert into department_members (company_id, department_id, user_id) values ($1, $2, $3), ($1, $2, $4)", [c.s.companyId, dept, u2, gone]);
  const [{ id: grp }] = (await c.s.owner.query("insert into groups (company_id, name) values ($1, 'G') returning id", [c.s.companyId])).rows;
  await c.s.owner.query("insert into group_members (group_id, company_id, user_id) values ($1, $2, $3)", [grp, c.s.companyId, u3]);
  for (const [kind, ref] of [["user", u2], ["department", dept], ["group", grp], ["user", gone]])
    await c.s.owner.query("insert into reminder_targets (reminder_id, company_id, kind, ref) values ($1, $2, $3, $4)", [rid, c.s.companyId, kind, ref]);
  await threshold(4);
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 0, "still 4: people reached twice count once, deactivated never");
});

test("V11: a suspended company isn't counted", async () => {
  const c = await company();
  await reminder(c, { title: "Suspended big", at: at(3), targets: outside(10) });
  await c.s.owner.query("update companies set suspended_at = now() where id = $1", [c.s.companyId]);
  await threshold(5);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 0, "suspended: sends nothing, so no alert");
  assert.equal(m.mails.length, 0);
  await c.s.owner.query("update companies set suspended_at = null where id = $1", [c.s.companyId]);
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 1, "control: alerted once unsuspended");
});

test("V12: another company's volume is never added; each company is alerted separately", async () => {
  const a = await company();
  const b = await company();
  await reminder(a, { title: "A half", at: at(3), targets: outside(3) });
  await reminder(b, { title: "B half", at: at(3), targets: outside(3) });
  await threshold(4);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, a.s.companyId, m.send), 0, "A has 3 (not 6)");
  assert.equal(await upcomingVolumeAlerts(NOW, b.s.companyId, m.send), 0, "B has 3 (not 6)");
  assert.equal(m.mails.length, 0);

  await reminder(a, { title: "A more", at: at(3), targets: outside(2) });
  await reminder(b, { title: "B more", at: at(3), targets: outside(3) });
  assert.equal(await upcomingVolumeAlerts(NOW, a.s.companyId, m.send), 1);
  const aText = m.all();
  assert.ok(aText.includes(a.name) && !aText.includes(b.name), "A's email names only A");
  assert.match(aText, /\b5\b/, "A's estimate is 5");
  assert.doesNotMatch(aText, /\b11\b/, "B's volume isn't added to A's");
  const before = m.mails.length;
  assert.equal(await upcomingVolumeAlerts(NOW, b.s.companyId, m.send), 1, "B is alerted separately for the same day");
  const bText = m.mails.slice(before).map((x) => JSON.stringify(x)).join();
  assert.ok(bText.includes(b.name) && !bText.includes(a.name), "B's email names only B");
  assert.match(bText, /\b6\b/, "B's estimate is 6");
});

test("V13: the email lists each busy day, its estimate, the top 3 reminders by volume and a console link", async () => {
  const c = await company();
  await reminder(c, { title: "Alpha send", at: at(3, "08:00"), targets: outside(5, "a") });
  await reminder(c, { title: "Bravo send", at: at(3, "09:00"), targets: outside(4, "b") });
  await reminder(c, { title: "Charlie send", at: at(3, "10:00"), targets: outside(3, "c") });
  await reminder(c, { title: "Delta tiny", at: at(3, "11:00"), targets: outside(1, "d") });
  await reminder(c, { title: "Echo send", at: at(5, "09:00"), targets: outside(11, "e") });
  await threshold(10);
  const m = capture();
  assert.equal(await upcomingVolumeAlerts(NOW, c.s.companyId, m.send), 2, "two busy days");
  const forOwner = m.mails.filter((x) => x.to === OWNERS[0]).map((x) => JSON.stringify(x)).join("\n");
  assert.ok(mentionsDay(forOwner, dayIso(3)) && mentionsDay(forOwner, dayIso(5)), `lists both busy days: ${forOwner}`);
  assert.match(forOwner, /\b13\b/, "day 3's estimate (13)");
  assert.match(forOwner, /\b11\b/, "day 5's estimate (11)");
  assert.match(forOwner, /Alpha send[^\n]{0,60}?\b5\b/, "top reminder with its recipients");
  assert.match(forOwner, /Bravo send[^\n]{0,60}?\b4\b/, "second reminder with its recipients");
  assert.match(forOwner, /Charlie send[^\n]{0,60}?\b3\b/, "third reminder with its recipients");
  assert.ok(!forOwner.includes("Delta tiny"), "only the top 3 are listed");
  assert.ok(forOwner.includes("Echo send"), "day 5's top reminder is listed");
  assert.match(forOwner, /https?:\/\/[^\s"]*\/platform/, "links to the platform console");
});

test("V14: the past-24-hours alert still works", async () => {
  const c = await company();
  const rid = await reminder(c, { title: "Already out", at: at(-1), targets: outside(1), status: "sent" });
  const [{ id: occ }] = (
    await c.s.owner.query("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now() - interval '1 hour', 'sent') returning id", [c.s.companyId, rid])
  ).rows;
  for (let i = 0; i < 3; i++)
    await c.s.owner.query("insert into deliveries (company_id, reminder_id, occurrence_id, address, status, sent_at) values ($1, $2, $3, $4, 'sent', now())", [c.s.companyId, rid, occ, `p${i}@outside.test`]);
  // A look-ahead alert recorded for today mustn't stop the past-24-hours one.
  await q("insert into platform_alerts (company_id, on_date, kind) values ($1, current_date, 'upcoming')", [c.s.companyId]);
  const m = capture();
  await threshold(10);
  assert.equal(await volumeAlerts(m.send, c.s.companyId), 0, "3 sent is under 10");
  await threshold(2);
  assert.equal(await volumeAlerts(m.send, c.s.companyId), 1, "3 sent in the last 24 hours is over 2");
  assert.deepEqual(m.mails.map((x) => x.to).sort(), [...OWNERS].sort());
  assert.equal(await volumeAlerts(m.send, c.s.companyId), 0, "once per day");
});
