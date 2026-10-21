// Behaviour tests from docs/expected-behaviour.md section 11: Invites (IN1–IN6),
// Replies (RS1–RS7) and the carried-over rules RC3 (erase / export) and RC4
// (audit log). Written from the spec, not the code: a failure means one of
// them is wrong.
//
// Events are seeded with raw SQL through the owner pool. Fixed dates are in
// 2031 so they are always "still to come"; a few use now() where the spec
// cares about "ended".
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { authDb } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { eventGuests, respond, respondByToken, rsvpTarget } from "@/lib/events";
import { eventIcs, rsvpUrl } from "@/lib/invite";
import type { sendMail } from "@/lib/mail";
import { MUTABLE } from "@/lib/notifications";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "@/lib/permissions";
import { exportPerson } from "@/lib/privacy";
import { reminderAccess } from "@/lib/reminders";
import { handleRsvpAction } from "@/lib/slack-actions";
import { seeder } from "@/lib/test-helpers";
import { erasePerson } from "@/lib/users";
import { ownerDb } from "./db";
import { deliverOne, dispatchInvites } from "./delivery";

const s = seeder();
const other = seeder(); // RS3: someone from another company
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

let admin: string, olga: string, alice: string, bob: string, carol: string, outsider: string;
let ops: string;
const TEAM = () => `T-${s.companyId}`;
const emailOf = (id: string) => `${id}@${s.domain}`;
const WEEKLY_MON = { freq: "weekly", interval: 1, weekdays: [0], end: { type: "never" } };

type Mail = Parameters<typeof sendMail>[0];
const capture = (box: Mail[]) => (async (m: Mail) => void box.push(m)) as unknown as typeof sendMail;

let n = 0;
type EventOpts = {
  title?: string;
  status?: string;
  channels?: string;
  recurrence?: object | null;
  sendAt?: Date | string; // a Date, or SQL like "now() + interval '1 day'"
  anchorLocal?: string;
  tz?: string;
  duration?: number;
  location?: string | null;
  meetingUrl?: string | null;
  by?: string;
  targets?: [string, string][]; // [kind, ref]
};
// An event (organiser olga by default) with the given guests (targets).
async function event(o: EventOpts = {}) {
  const sendAtSql = typeof o.sendAt === "string" ? `coalesce($7::timestamptz, ${o.sendAt})` : "$7::timestamptz";
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status, time_zone, anchor_local,
       is_event, duration_minutes, location, meeting_url, channels, recurrence)
     values ($1, $2, $3, $4, 'Bring numbers', 'Olga', ${sendAtSql}, $5, $6, $8, true, $9, $10, $11, $12, $13) returning id`,
    [
      s.companyId,
      `EV-${s.companyId.slice(0, 6)}-${n++}`,
      o.by ?? olga,
      o.title ?? "Planning",
      o.status ?? "scheduled",
      o.tz ?? "UTC",
      o.sendAt instanceof Date ? o.sendAt : typeof o.sendAt === "string" ? null : new Date("2031-03-03T09:00:00Z"),
      o.anchorLocal ?? "2031-03-03T09:00",
      o.duration ?? 60,
      o.location === undefined ? "Room 2, Floor 3" : o.location,
      o.meetingUrl === undefined ? "https://meet.example.com/abc-defg" : o.meetingUrl,
      o.channels ?? "{email}",
      o.recurrence ? JSON.stringify(o.recurrence) : null,
    ],
  );
  for (const [kind, ref] of o.targets ?? [["user", alice]]) await q("insert into reminder_targets values ($1, $2, $3, $4)", [id, s.companyId, kind, ref]);
  return id as string;
}
// Runs the invite dispatcher for our company; returns the queued delivery ids.
const dispatch = async (now?: Date) => {
  const ids: string[] = [];
  await dispatchInvites(async (x) => void ids.push(...x), s.companyId, now);
  return ids;
};
const invitesOf = async (id: string) =>
  q("select id, channel, user_id, address, occurrence_id, status from deliveries where reminder_id = $1 and kind = 'invite' order by channel, user_id", [id]);
const answers = async (id: string) => q("select user_id, answer from event_responses where reminder_id = $1 order by user_id", [id]);
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");
const tokenOf = (url: string) => decodeURIComponent(url.split("/rsvp/")[1].split("?")[0]);

// Fake Slack for sending (DM) and for button clicks (users.info, chat.update).
function fakeSlack(emails: Record<string, string> = {}) {
  const posts: { channel: string; text: string; blocks: { block_id?: string; elements?: { action_id: string; value?: string }[] }[] }[] = [];
  const updates: string[] = [];
  const ephemerals: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const json = (b: object) => new Response(JSON.stringify(b));
    if (url.startsWith("https://hooks.test/")) {
      ephemerals.push(JSON.parse(init.body as string).text);
      return json({ ok: true });
    }
    const p = init.body as URLSearchParams;
    const method = url.split("/").pop();
    if (method === "users.lookupByEmail") return json({ ok: true, user: { id: `U-${p.get("email")}` } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: `D-${p.get("users")}` } });
    if (method === "chat.postMessage") {
      posts.push({ channel: p.get("channel")!, text: p.get("text")!, blocks: JSON.parse(p.get("blocks") ?? "[]") });
      return json({ ok: true, channel: p.get("channel"), ts: "1.0" });
    }
    if (method === "users.info") {
      const email = emails[p.get("user")!];
      return json({ ok: true, user: { profile: email ? { email } : {} } });
    }
    if (method === "chat.update") {
      updates.push(p.get("blocks") ?? "");
      return json({ ok: true });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  return { f, posts, updates, ephemerals };
}

before(async () => {
  await s.company();
  await other.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [olga, alice, bob, carol] = [await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] })];
  for (const [id, name] of [[olga, "Olga"], [alice, "Alice"], [bob, "Bob"], [carol, "Carol"]]) await q(`update "user" set name = $2 where id = $1`, [id, name]);
  outsider = await other.user({ roles: [MEMBER_ROLE_ID] });
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, $2) returning id", [s.companyId, `Ops-${randomUUID().slice(0, 6)}`]);
  for (const u of [alice, bob]) await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, u]);
  await q("insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'WS', $3, 'UBOT')", [
    s.companyId,
    TEAM(),
    encrypt("xoxb-test"),
  ]);
});
after(async () => {
  await other.cleanup();
  await s.cleanup();
  await ownerDb.$client.end();
  await db.$client.end();
  await authDb.$client.end();
});

// --- Invites -------------------------------------------------------------------

test("IN1: a scheduled event invites each guest at once (email: title, when, where, Join, Yes/No/Maybe, .ics; Slack DM with buttons), following its channels", async () => {
  const id = await event({ channels: "{email,slack}", targets: [["department", ops]] });
  // "At once": the start is in 2031; dispatching now already queues them.
  const ids = await dispatch();
  const rows = await invitesOf(id);
  assert.deepEqual(
    rows.map((r) => [r.channel, r.user_id]),
    [
      ["email", alice],
      ["email", bob],
      ["slack", alice],
      ["slack", bob],
    ].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])),
  );
  assert.equal(ids.length, 4);

  // The email to alice.
  const box: Mail[] = [];
  const mailRow = rows.find((r) => r.channel === "email" && r.user_id === alice)!;
  assert.equal(await deliverOne(mailRow.id, capture(box)), "sent");
  assert.equal(box.length, 1);
  const m = box[0];
  assert.match(`${m.subject}\n${m.text}`, /Planning/, "title");
  assert.match(m.text, /(Mar|March|03)/, "when: the date");
  assert.match(m.text, /9[:.]00/, "when: the time");
  assert.match(m.text, /Room 2, Floor 3/, "where");
  const links = m.links ?? [];
  assert.ok(
    links.some((l) => l.url === "https://meet.example.com/abc-defg" && /join/i.test(l.label)),
    `a Join link: ${JSON.stringify(links)}`,
  );
  for (const a of ["yes", "no", "maybe"])
    assert.equal(links.filter((l) => new RegExp(`/rsvp/[^?]+\\?a=${a}$`).test(l.url)).length, 1, `one ${a} link: ${JSON.stringify(links)}`);
  const ics = (m.attachments ?? []).find((a) => /\.ics$/.test(a.filename));
  assert.ok(ics, "an .ics attachment");
  assert.match(ics.contentType, /^text\/calendar/);

  // The Slack DM to bob.
  const sl = fakeSlack();
  const slackRow = rows.find((r) => r.channel === "slack" && r.user_id === bob)!;
  assert.equal(await deliverOne(slackRow.id, undefined, sl.f), "sent");
  assert.equal(sl.posts.length, 1);
  assert.match(sl.posts[0].text, /Planning/);
  const buttons = sl.posts[0].blocks.flatMap((b) => b.elements ?? []);
  for (const a of ["rsvp_yes", "rsvp_no", "rsvp_maybe"])
    assert.ok(
      buttons.some((b) => b.action_id === a && b.value === id),
      `${a} button for the event: ${JSON.stringify(buttons)}`,
    );

  // Channels followed: an email-only event gets no Slack invites.
  const emailOnly = await event({ channels: "{email}" });
  await dispatch();
  assert.deepEqual((await invitesOf(emailOnly)).map((r) => r.channel), ["email"]);
});

test("IN2: one invite per guest, exactly once even with reruns and retries, addressed only to them", async () => {
  // alice is both a named guest and in the guest department: still one invite.
  const id = await event({ targets: [["user", alice], ["department", ops]] });
  await dispatch();
  await dispatch();
  const rows = await invitesOf(id);
  assert.deepEqual(rows.map((r) => r.user_id).sort(), [alice, bob].sort());
  for (const r of rows) assert.equal(r.address, emailOf(r.user_id));
  assert.ok(rows.every((r) => r.occurrence_id === null));

  // A failed attempt, then a retry: one email in the end; another run sends nothing.
  const d = rows.find((r) => r.user_id === alice)!.id;
  const box: Mail[] = [];
  let calls = 0;
  const flaky = (async (m: Mail) => {
    if (calls++ === 0) throw new Error("SMTP down");
    box.push(m);
  }) as unknown as typeof sendMail;
  // A transient failure throws so the queue retries it (MAX_ATTEMPTS).
  await assert.rejects(deliverOne(d, flaky), /SMTP down/);
  assert.equal(await deliverOne(d, flaky), "sent");
  assert.equal(await deliverOne(d, flaky), "skipped");
  // Two at the same time: only one sends.
  const d2 = rows.find((r) => r.user_id === bob)!.id;
  const res = await Promise.all([deliverOne(d2, capture(box)), deliverOne(d2, capture(box))]);
  assert.deepEqual(res.sort(), ["sent", "skipped"]);
  assert.deepEqual(box.map((m) => m.to).sort(), [emailOf(alice), emailOf(bob)].sort());
  for (const m of box) assert.ok(!m.to.includes(","), "one recipient per email");
  // Bob's Yes link answers for bob, not alice.
  const bobMail = box.find((m) => m.to === emailOf(bob))!;
  assert.equal(await respondByToken(tokenOf(bobMail.links!.find((l) => /\?a=yes$/.test(l.url))!.url), "yes"), null);
  assert.deepEqual(await answers(id), [{ user_id: bob, answer: "yes" }]);
});

// Left for a manual check: actually importing the file into Google Calendar,
// Outlook and Apple Calendar. Checked here: RFC 5545 shape (CRLF lines,
// METHOD:REQUEST, VEVENT), UTC times, title, place (escaped) and the link.
test("IN3: the .ics has the right time in UTC, the title, place and link (import into Google / Outlook / Apple left for a manual check)", async () => {
  // 10:00 in Kolkata (UTC+5:30) is 04:30Z.
  const id = await event({ title: "Budget review", tz: "Asia/Kolkata", sendAt: new Date("2031-03-03T04:30:00Z"), anchorLocal: "2031-03-03T10:00", duration: 45 });
  await dispatch();
  const [row] = await invitesOf(id);
  const box: Mail[] = [];
  assert.equal(await deliverOne(row.id, capture(box)), "sent");
  const att = box[0].attachments!.find((a) => /\.ics$/.test(a.filename))!;
  assert.match(att.contentType, /method=REQUEST/i);
  const raw = att.content.toString();
  assert.ok(!/[^\r]\n/.test(raw), "lines end in CRLF");
  const ics = unfold(raw);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nVERSION:2\.0\r\n/);
  assert.match(ics, /\r\nPRODID:/);
  assert.match(ics, /\r\nMETHOD:REQUEST\r\n/);
  assert.match(ics, /\r\nBEGIN:VEVENT\r\n/);
  assert.match(ics, new RegExp(`\\r\\nUID:[^\\r]*${id}`));
  assert.match(ics, /\r\nDTSTAMP:\d{8}T\d{6}Z\r\n/);
  assert.match(ics, /\r\nDTSTART:20310303T043000Z\r\n/);
  assert.match(ics, /\r\nDTEND:20310303T051500Z\r\n/);
  assert.match(ics, /\r\nSUMMARY:Budget review\r\n/);
  assert.match(ics, /\r\nLOCATION:Room 2\\, Floor 3\r\n/);
  assert.ok(ics.includes("https://meet.example.com/abc-defg"), "the meeting link is in the .ics");
  assert.match(ics, new RegExp(`\\r\\nATTENDEE[^\\r]*mailto:${emailOf(alice)}`, "i"));
  assert.match(ics, /\r\nORGANIZER[^\r]*mailto:/i);
  assert.match(ics, /\r\nEND:VEVENT\r\nEND:VCALENDAR(\r\n)?$/);

  // The same through eventIcs directly.
  const direct = unfold(
    eventIcs(
      {
        id,
        title: "Budget review",
        description: "Bring numbers",
        sendAt: new Date("2031-03-03T04:30:00Z"),
        durationMinutes: 45,
        allDay: false,
        location: "Room 2, Floor 3",
        meetingUrl: "https://meet.example.com/abc-defg",
        recurrence: null,
        anchorLocal: "2031-03-03T10:00",
        timeZone: "Asia/Kolkata",
      },
      { organizer: { name: "Olga", email: emailOf(olga) }, attendee: { name: "Alice", email: emailOf(alice) }, url: "https://app.test/r/x" },
    ).toString(),
  );
  assert.match(direct, /DTSTART:20310303T043000Z/);
  assert.match(direct, /DTEND:20310303T051500Z/);
});

test("IN4: a repeating event gets one invite for the series, its .ics repeats", async () => {
  const id = await event({ recurrence: WEEKLY_MON, sendAt: new Date("2031-03-03T10:00:00Z"), anchorLocal: "2031-03-03T10:00", duration: 30 });
  await dispatch();
  // Later runs (even after the first dates) add nothing.
  await dispatch();
  await dispatch(new Date("2031-03-20T00:00:00Z"));
  const rows = await invitesOf(id);
  assert.equal(rows.length, 1);
  const box: Mail[] = [];
  assert.equal(await deliverOne(rows[0].id, capture(box)), "sent");
  const ics = unfold(box[0].attachments!.find((a) => /\.ics$/.test(a.filename))!.content.toString());
  assert.match(ics, /\r\nRRULE:FREQ=WEEKLY[^\r]*BYDAY=MO/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 1, "one VEVENT for the series");
  assert.match(ics, /DTSTART[^\r]*:20310303T10/);
});

test("IN5: no invites while waiting for approval or after rejection; invites once approved", async () => {
  const waiting = await event({ status: "pending_approval" });
  const rejected = await event({ status: "rejected" });
  await dispatch();
  assert.equal((await invitesOf(waiting)).length, 0);
  assert.equal((await invitesOf(rejected)).length, 0);
  await q("update reminders set status = 'scheduled' where id = $1", [waiting]);
  await dispatch();
  assert.equal((await invitesOf(waiting)).length, 1);
  assert.equal((await invitesOf(rejected)).length, 0);
});

test("IN6: someone joining a guest department or group later gets an invite if the event is still to come", async () => {
  const [{ id: grp }] = await q("insert into groups (company_id, name) values ($1, $2) returning id", [s.companyId, `G-${randomUUID().slice(0, 6)}`]);
  const upcoming = await event({ targets: [["department", ops], ["group", grp]] });
  const ended = await event({ sendAt: "now() - interval '3 hours'", status: "sent", targets: [["department", ops], ["group", grp]] });
  await dispatch();
  assert.deepEqual((await invitesOf(upcoming)).map((r) => r.user_id).sort(), [alice, bob].sort());
  // carol joins the department; then a new person joins the group.
  await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, carol]);
  const dan = await s.user({ roles: [MEMBER_ROLE_ID] });
  await q("insert into group_members values ($1, $2, $3)", [grp, s.companyId, dan]);
  await dispatch();
  assert.deepEqual((await invitesOf(upcoming)).map((r) => r.user_id).sort(), [alice, bob, carol, dan].sort());
  assert.equal((await invitesOf(ended)).length, 0, "an event that has ended invites nobody");
  await q("delete from department_members where user_id = $1", [carol]);
});

// --- Replies -------------------------------------------------------------------

test("RS1: a guest answers by email link, Slack button and the event page; can change it until the event ends", async () => {
  const id = await event({ channels: "{email,slack}", targets: [["user", alice], ["user", bob]], sendAt: "now() + interval '1 day'" });
  // The event page / calendar card (both call respond for the signed-in person).
  assert.equal(await respond(s.companyId, alice, id, "yes", alice), null);
  assert.deepEqual(await answers(id), [{ user_id: alice, answer: "yes" }]);
  assert.equal(await respond(s.companyId, alice, id, "maybe", alice), null);
  assert.deepEqual(await answers(id), [{ user_id: alice, answer: "maybe" }]);
  // The email link.
  assert.equal(await respondByToken(tokenOf(rsvpUrl(s.companyId, id, alice, "no")), "no"), null);
  assert.deepEqual(await answers(id), [{ user_id: alice, answer: "no" }]);
  // A Slack button.
  const sl = fakeSlack({ UBOB: emailOf(bob) });
  const r = await handleRsvpAction(
    {
      teamId: TEAM(),
      slackUserId: "UBOB",
      channelId: "D1",
      messageTs: "1.0",
      responseUrl: "https://hooks.test/r",
      blocks: [{ type: "actions", block_id: "rsvp" }],
      actionId: "rsvp_maybe",
      eventId: id,
    },
    sl.f,
  );
  await r.after();
  assert.equal(r.outcome, "answered");
  const sorted = [
    { user_id: alice, answer: "no" },
    { user_id: bob, answer: "maybe" },
  ].sort((a, b) => a.user_id.localeCompare(b.user_id));
  assert.deepEqual(await answers(id), sorted);
  // During the event: still open. After it ends: refused, answer kept.
  const startsAt = new Date(Date.now() + 86_400_000);
  assert.equal(await respond(s.companyId, alice, id, "yes", alice, new Date(startsAt.getTime() + 30 * 60_000)), null);
  assert.equal(typeof (await respond(s.companyId, alice, id, "no", alice, new Date(startsAt.getTime() + 2 * 3_600_000))), "string");
  const ended = await event({ sendAt: "now() - interval '3 hours'", status: "sent" });
  assert.equal(typeof (await respond(s.companyId, alice, ended, "yes", alice)), "string");
  assert.equal(typeof (await respondByToken(tokenOf(rsvpUrl(s.companyId, ended, alice, "yes")), "yes")), "string");
  assert.deepEqual(await answers(ended), []);
  // Not an answer: refused.
  assert.equal(typeof (await respond(s.companyId, bob, id, "perhaps", bob)), "string");
});

test("RS2: email links are signed per guest and event, work without sign-in, can't be used for someone else, and opening one doesn't answer", async () => {
  const id = await event({ targets: [["user", alice], ["user", bob]] });
  const otherEvent = await event({ targets: [["user", alice], ["user", bob]] });
  const url = rsvpUrl(s.companyId, id, alice, "yes");
  assert.match(url, /\/rsvp\/[^?]+\?a=yes$/);
  const token = tokenOf(url);
  // Opening the link (the confirm page) shows the event and saves nothing.
  const target = await rsvpTarget(token);
  assert.ok(target, "a valid link opens");
  assert.equal(target.title, "Planning");
  assert.deepEqual(await answers(id), [], "opening the link alone doesn't answer (mail scanners)");
  // A tampered token is refused, for both the page and the answer.
  const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
  assert.equal(await rsvpTarget(tampered), null);
  assert.equal(typeof (await respondByToken(tampered, "yes")), "string");
  // A token from another company's key / random text: refused.
  assert.equal(typeof (await respondByToken("not-a-token", "yes")), "string");
  // The confirm click: answers for alice only, on this event only.
  assert.equal(await respondByToken(token, "yes"), null);
  assert.deepEqual(await answers(id), [{ user_id: alice, answer: "yes" }]);
  assert.deepEqual(await answers(otherEvent), []);
  // Tokens differ per guest and per event.
  assert.notEqual(tokenOf(rsvpUrl(s.companyId, id, bob, "yes")), token);
  assert.notEqual(tokenOf(rsvpUrl(s.companyId, otherEvent, alice, "yes")), token);
  // A token for someone who isn't a guest (signed, but not invited) is refused.
  assert.equal(typeof (await respondByToken(tokenOf(rsvpUrl(s.companyId, id, carol, "yes")), "yes")), "string");
});

test("RS3: someone who isn't a guest can't answer (a colleague, the organiser, another company, a Slack user who isn't invited)", async () => {
  const id = await event({ targets: [["user", alice]] });
  assert.equal(typeof (await respond(s.companyId, carol, id, "yes", carol)), "string", "a colleague not invited");
  // EV8: the organiser isn't a guest (counts as Yes, never answers).
  assert.equal(typeof (await respond(s.companyId, olga, id, "no", olga)), "string", "the organiser");
  assert.equal(typeof (await respond(s.companyId, outsider, id, "yes", outsider)), "string", "another company's user, our company");
  assert.equal(typeof (await respond(other.companyId, outsider, id, "yes", outsider)), "string", "another company's user, their company");
  const sl = fakeSlack({ UCAROL: emailOf(carol) });
  const r = await handleRsvpAction(
    { teamId: TEAM(), slackUserId: "UCAROL", channelId: "C1", messageTs: "1.0", responseUrl: "https://hooks.test/r", blocks: [], actionId: "rsvp_yes", eventId: id },
    sl.f,
  );
  await r.after();
  assert.equal(r.outcome, "refused");
  assert.deepEqual(await answers(id), []);
});

test("RS4: the organiser sees counts and names: Yes, No, Maybe, no answer yet", async () => {
  const id = await event({ targets: [["department", ops], ["user", carol], ["user", admin]] });
  assert.equal(await respond(s.companyId, alice, id, "yes", alice), null);
  assert.equal(await respond(s.companyId, bob, id, "no", bob), null);
  assert.equal(await respond(s.companyId, carol, id, "maybe", carol), null);
  // The organiser has full access to the event page (names shown).
  assert.equal(await reminderAccess(s.companyId, { id: olga, email: emailOf(olga), access: await loadAccess(s.companyId, olga) }, { id, createdBy: olga }), "full");
  const g = await eventGuests(s.companyId, { id, createdBy: olga, creatorName: "Olga" });
  const byId = new Map(g.list.map((x) => [x.id, x]));
  assert.equal(byId.get(alice)?.answer, "yes");
  assert.equal(byId.get(alice)?.name, "Alice");
  assert.equal(byId.get(bob)?.answer, "no");
  assert.equal(byId.get(carol)?.answer, "maybe");
  assert.equal(byId.get(admin)?.answer ?? null, null, "admin hasn't answered");
  // Counts agree with the names (EV8: the organiser, if listed, counts as Yes).
  const tally = { yes: 0, maybe: 0, no: 0, none: 0 };
  for (const x of g.list) tally[x.answer ?? "none"]++;
  assert.deepEqual(g.counts, tally);
  assert.equal(g.counts.none, 1);
  assert.equal(g.counts.no, 1);
  assert.equal(g.counts.maybe, 1);
  const org = byId.get(olga);
  if (org) assert.equal(org.answer, "yes", "EV8: the organiser counts as Yes");
});

// The page shows names only to "full" viewers (see reminders/[id]/page.tsx);
// what a guest's page looks like is left for a browser check.
test("RS5: a guest sees their own answer and the totals, not who said what", async () => {
  const id = await event({ targets: [["user", alice], ["user", bob]] });
  assert.equal(await respond(s.companyId, alice, id, "maybe", alice), null);
  assert.equal(await respond(s.companyId, bob, id, "no", bob), null);
  // A guest can open it, but not in full (names are for full viewers).
  const access = await reminderAccess(s.companyId, { id: alice, email: emailOf(alice), access: await loadAccess(s.companyId, alice) }, { id, createdBy: olga });
  assert.equal(access, "viewer");
  const g = await eventGuests(s.companyId, { id, createdBy: olga, creatorName: "Olga" });
  assert.equal(g.list.find((x) => x.id === alice)?.answer, "maybe", "their own answer");
  assert.equal(g.counts.maybe, 1);
  assert.equal(g.counts.no, 1);
});

test("RS6: a repeating event has one answer for the whole series", async () => {
  // Started weekly in the past and goes on: still open for answers.
  const id = await event({ recurrence: WEEKLY_MON, sendAt: "now() + interval '1 day'", anchorLocal: "2026-10-05T10:00", targets: [["user", alice]] });
  assert.equal(await respond(s.companyId, alice, id, "yes", alice), null);
  assert.equal(await respond(s.companyId, alice, id, "maybe", alice), null);
  const rows = await q("select * from event_responses where reminder_id = $1", [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].answer, "maybe");
  assert.ok(!("occurrence_id" in rows[0]) || rows[0].occurrence_id === null, "not tied to one date");
  // Still open weeks later (the series hasn't ended).
  assert.equal(await respond(s.companyId, alice, id, "no", alice, new Date(Date.now() + 30 * 86_400_000)), null);
});

test("RS7: the organiser gets one in-app notification per answer (not per date), mutable by email", async () => {
  const id = await event({ recurrence: WEEKLY_MON, sendAt: new Date("2031-03-03T10:00:00Z"), anchorLocal: "2031-03-03T10:00", targets: [["user", alice], ["user", bob]] });
  const notes = () => q("select user_id, kind, actor_id from notifications where reminder_id = $1 order by created_at", [id]);
  assert.equal(await respond(s.companyId, alice, id, "yes", alice), null);
  assert.deepEqual(await notes(), [{ user_id: olga, kind: "rsvp", actor_id: alice }], "one notification for a series answer");
  assert.equal(await respond(s.companyId, bob, id, "no", bob), null);
  // Literal reading of "one notification per answer": a changed answer is a new answer.
  assert.equal(await respond(s.companyId, alice, id, "no", alice), null);
  const all = await notes();
  assert.equal(all.length, 3, `one per answer: ${JSON.stringify(all)}`);
  assert.ok(all.every((x) => x.user_id === olga && x.kind === "rsvp"));
  // Mutable by email: answers are a mutable event with an email channel.
  const m = MUTABLE.find((x) => x.event === "rsvp");
  assert.ok(m, "rsvp is mutable");
  assert.ok((m.channels as readonly string[]).includes("email"));
});

// --- Rules carried over --------------------------------------------------------

test("RC3: a person's answers are in their export and removed on erase", async () => {
  const eve = await s.user({ roles: [MEMBER_ROLE_ID] });
  const id = await event({ title: "Offsite day", targets: [["user", eve]] });
  assert.equal(await respond(s.companyId, eve, id, "maybe", eve), null);
  const data = JSON.stringify(await exportPerson(s.companyId, eve));
  assert.ok(data.includes("Offsite day") || data.includes(id), "the export names the event");
  assert.match(data, /"maybe"/, "the export holds the answer");
  await q(`update "user" set deactivated_at = now() where id = $1`, [eve]);
  assert.equal(await erasePerson({ id: admin, access: await loadAccess(s.companyId, admin) } as never, s.companyId, eve), null);
  assert.deepEqual(await answers(id), [], "answers removed on erase");
});

// The audit trigger records changes made by a person (withTenant with an
// actor), so the event is created and changed as olga, not via the owner pool.
test("RC4: creating, changing and answering an event are in the audit log", async () => {
  const created = await withTenant(
    s.companyId,
    (tx) =>
      tx.execute(sql`insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_event, duration_minutes, location, channels)
        values (${s.companyId}, ${`EV-AUD-${s.companyId.slice(0, 6)}`}, ${olga}, 'Audited event', 'Olga', '2031-03-03T09:00:00Z', 'scheduled', 'UTC', '2031-03-03T09:00', true, 60, 'Room 2', '{email}') returning id`),
    olga,
  );
  const id = (created.rows[0] as { id: string }).id;
  await q("insert into reminder_targets values ($1, $2, 'user', $3)", [id, s.companyId, alice]);
  await withTenant(s.companyId, (tx) => tx.execute(sql`update reminders set location = 'Room 9', duration_minutes = 90 where id = ${id}`), olga);
  const log = (type: string) =>
    q("select action, actor_id, object_id, changes from audit_log where company_id = $1 and object_type = $2 and object_id = $3 order by id", [s.companyId, type, id]);
  const rem = await log("reminders");
  assert.deepEqual(rem.map((r) => [r.action, r.actor_id]), [["create", olga], ["update", olga]]);
  assert.equal(rem[0].changes.is_event, true);
  assert.deepEqual(rem[1].changes.location, ["Room 2", "Room 9"]);
  assert.deepEqual(rem[1].changes.duration_minutes, [60, 90]);
  assert.equal(await respond(s.companyId, alice, id, "yes", alice), null);
  assert.equal(await respond(s.companyId, alice, id, "no", alice), null);
  const ans = await log("event_responses");
  assert.deepEqual(ans.map((r) => [r.action, r.actor_id]), [["create", alice], ["update", alice]]);
  assert.equal(ans[0].changes.answer, "yes");
  assert.deepEqual(ans[1].changes.answer, ["yes", "no"]);
});
