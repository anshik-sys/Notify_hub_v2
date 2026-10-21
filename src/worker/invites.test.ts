import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { encrypt } from "@/lib/crypto";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { deliverOne, dispatchDue, dispatchInvites } from "./delivery";

// PRD 14.3 invites from the worker: IN1, IN2, IN4, IN5, IN6, EV8.
const s = seeder();
let creator: string, alice: string, bob: string, ops: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
let n = 0;
async function event(over: { status?: string; channels?: string; recurrence?: object } = {}) {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status, time_zone, anchor_local,
       is_event, duration_minutes, location, meeting_url, channels, recurrence)
     values ($1, $2, $3, 'Planning', 'Bring numbers', 'Olga', now() + interval '1 day', $4, 'UTC', '2026-11-02T10:00', true, 60,
       'Room 2', 'https://meet.example.com/abc', $5, $6) returning id`,
    [s.companyId, `I-${s.companyId.slice(0, 6)}-${n++}`, creator, over.status ?? "scheduled", over.channels ?? "{email}", over.recurrence ?? null],
  );
  await q("insert into reminder_targets values ($1, $2, 'department', $3)", [id, s.companyId, ops]);
  return id as string;
}
const dispatch = async () => {
  const ids: string[] = [];
  await dispatchInvites(async (x) => void ids.push(...x), s.companyId);
  return ids;
};
const invitesOf = async (id: string) =>
  (await q("select channel, user_id, occurrence_id, status from deliveries where reminder_id = $1 and kind = 'invite' order by channel, user_id", [id]));

before(async () => {
  await s.company();
  [creator, alice, bob] = [await s.user(), await s.user(), await s.user()];
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  // The organiser is in the guest department too: they still get no invite (EV8).
  for (const u of [creator, alice]) await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, u]);
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
});

test("scheduled: one invite per guest at once, never the organiser; a rerun adds nothing", async () => {
  const id = await event();
  const ids = await dispatch();
  const rows = await invitesOf(id);
  assert.deepEqual(rows.map((r) => [r.channel, r.user_id, r.occurrence_id, r.status]), [["email", alice, null, "queued"]]);
  assert.equal(ids.length, 1);
  assert.deepEqual(await dispatch(), []);
  // Its start still sends nothing itself, and doesn't touch the invites.
  await dispatchDue(async () => {}, s.companyId, new Date(Date.now() + 2 * 86_400_000));
  assert.equal((await invitesOf(id)).length, 1);
});

test("the email: invite with when, where, Join, answer links and an .ics; sent once", async () => {
  const id = await event();
  const [d] = await dispatch();
  const sent: Parameters<typeof import("@/lib/mail").sendMail>[0][] = [];
  const results = await Promise.all([
    deliverOne(d, async (m) => void sent.push(m) as never),
    deliverOne(d, async (m) => void sent.push(m) as never),
  ]);
  assert.deepEqual(results.sort(), ["sent", "skipped"]);
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, `${alice}@${s.domain}`);
  assert.equal(m.subject, "Invitation: Planning");
  assert.match(m.text, /When: .*\nWhere: Room 2/);
  assert.deepEqual(
    m.links!.map((l) => l.label),
    ["Yes, I'll be there", "Maybe", "No, I can't come", "Join the meeting", "Open in NotifyHub"],
  );
  assert.match(m.links![0].url, /\/rsvp\/[^?]+\?a=yes$/);
  const ics = m.attachments![0];
  assert.equal(ics.filename, "invite.ics");
  assert.match(ics.contentType, /^text\/calendar.*method=REQUEST/);
  assert.match(ics.content.toString(), new RegExp(`UID:${id}@notifyhub`));
  assert.deepEqual((await invitesOf(id)).map((r) => r.status), ["sent"]);
});

test("a series gets one invite, with an RRULE (IN4)", async () => {
  const id = await event({ recurrence: { freq: "weekly", interval: 1, weekdays: [0], end: { type: "never" } } });
  const ids = await dispatch();
  assert.equal(ids.length, 1);
  let ics = "";
  await deliverOne(ids[0], async (m) => void (ics = m.attachments![0].content.toString()) as never);
  assert.match(ics, /RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO/);
  assert.equal((await invitesOf(id)).length, 1);
});

test("waiting for approval or rejected: no invites until it's scheduled (IN5)", async () => {
  const waiting = await event({ status: "pending_approval" });
  const rejected = await event({ status: "rejected" });
  await dispatch();
  assert.equal((await invitesOf(waiting)).length, 0);
  assert.equal((await invitesOf(rejected)).length, 0);
  await q("update reminders set status = 'scheduled' where id = $1", [waiting]);
  await dispatch();
  assert.equal((await invitesOf(waiting)).length, 1);
});

test("someone joining a guest department later gets their invite (IN6); a past event doesn't", async () => {
  const id = await event();
  const past = await event();
  await q("update reminders set send_at = now() - interval '2 hours', status = 'sent' where id = $1", [past]);
  await dispatch();
  await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, bob]);
  await dispatch();
  assert.deepEqual((await invitesOf(id)).map((r) => r.user_id).sort(), [alice, bob].sort());
  assert.equal((await invitesOf(past)).length, 0);
  await q("delete from department_members where user_id = $1", [bob]);
});

test("Slack: a DM with Yes / Maybe / No buttons carrying the event", async () => {
  await q("insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'WS', $3, 'UBOT')", [
    s.companyId,
    `T-${s.companyId}`,
    encrypt("xoxb-test"),
  ]);
  const id = await event({ channels: "{slack}" });
  const [d] = await dispatch();
  const posts: { text: string; buttons: { action_id: string; value?: string }[] }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const p = init.body as URLSearchParams;
    const json = (b: object) => new Response(JSON.stringify(b));
    if (method === "users.lookupByEmail") return json({ ok: true, user: { id: "U1" } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: "D1" } });
    if (method === "chat.postMessage") {
      const blocks = JSON.parse(p.get("blocks")!) as { block_id?: string; elements?: { action_id: string; value?: string }[] }[];
      posts.push({ text: p.get("text")!, buttons: blocks.find((b) => b.block_id === "rsvp")!.elements! });
      return json({ ok: true, channel: "D1", ts: "1.0" });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  assert.equal(await deliverOne(d, undefined, f), "sent");
  assert.match(posts[0].text, /^Invitation: Planning/);
  assert.deepEqual(
    posts[0].buttons.map((b) => [b.action_id, b.value]),
    [
      ["rsvp_yes", id],
      ["rsvp_maybe", id],
      ["rsvp_no", id],
      ["open", undefined],
    ],
  );
});
