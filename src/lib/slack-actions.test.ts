import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "./auth";
import { encrypt } from "./crypto";
import { type Click, handleTaskAction } from "./slack-actions";
import { seeder } from "./test-helpers";

const s = seeder();
let alice: string, bob: string, occ: string, team: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

// Fake Slack: users.info by Slack id; records chat.update and response_url posts.
function fake(emails: Record<string, string>) {
  const updates: { channel: string; status: string }[] = [];
  const ephemerals: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const json = (b: object) => new Response(JSON.stringify(b));
    if (url.startsWith("https://hooks.test/")) {
      ephemerals.push(JSON.parse(init.body as string).text);
      return json({ ok: true });
    }
    const p = init.body as URLSearchParams;
    const method = url.split("/").pop();
    if (method === "users.info") {
      const email = emails[p.get("user")!];
      return json({ ok: true, user: { profile: email ? { email } : {} } });
    }
    if (method === "chat.update") {
      const blocks = JSON.parse(p.get("blocks")!) as { block_id?: string; elements?: { text: string }[] }[];
      updates.push({ channel: p.get("channel")!, status: blocks.find((b) => b.block_id === "status")!.elements![0].text });
      return json({ ok: true });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  return { f, updates, ephemerals };
}

before(async () => {
  await s.company();
  await q("update companies set time_zone = 'Asia/Kolkata' where id = $1", [s.companyId]);
  [alice, bob] = [await s.user(), await s.user()];
  team = `T-${s.companyId}`;
  await q("insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'WS', $3, 'UBOT')", [
    s.companyId,
    team,
    encrypt("xoxb-test"),
  ]);
  const [{ id: r }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes, channels)
     values ($1, $2, $3, 'File expenses', 'HR', now() + interval '1 hour', 'sent', 'Asia/Kolkata', '2026-01-01T00:00', true, 60, '{slack}') returning id`,
    [s.companyId, `R-A${s.companyId.slice(0, 5).toUpperCase()}`, alice],
  );
  [{ id: occ }] = await q(
    "insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, due_at) values ($1, $2, now(), 'sent', now() + interval '1 hour') returning id",
    [s.companyId, r],
  );
  await q("insert into task_assignments (company_id, reminder_id, occurrence_id, user_id) values ($1, $2, $3, $4)", [s.companyId, r, occ, alice]);
});
after(async () => {
  await s.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

const emails = () => ({ UALICE: `${alice}@${s.domain}`, UBOB: `${bob}@${s.domain}` });
const click = (over: Partial<Click>): Click => ({
  teamId: team,
  slackUserId: "UALICE",
  actionId: "task_done",
  occurrenceId: occ,
  channelId: "D1",
  messageTs: "1.0",
  responseUrl: "https://hooks.test/r",
  blocks: [{ type: "header" }, { type: "actions", block_id: "task" }],
  ...over,
});
const state = async () => (await q("select done_at, snoozed_until from task_assignments where occurrence_id = $1", [occ]))[0];

test("refusals: unknown workspace, not an assignee, no email on profile", async () => {
  const sl = fake(emails());
  assert.equal((await handleTaskAction(click({ teamId: "T-nope" }), sl.f)).outcome, "unknown");
  const notMine = await handleTaskAction(click({ slackUserId: "UBOB" }), sl.f);
  await notMine.after();
  assert.equal(notMine.outcome, "refused");
  assert.deepEqual(sl.ephemerals, ["This task isn't assigned to you."]);
  assert.equal((await handleTaskAction(click({ slackUserId: "UNOEMAIL" }), sl.f)).outcome, "refused");
  assert.deepEqual(await state(), { done_at: null, snoozed_until: null });
});

test("snooze 1h and until tomorrow 09:00 local; the DM is updated", async () => {
  const sl = fake(emails());
  const now = new Date("2026-10-07T20:00:00Z"); // 01:30 on 8 Oct in Kolkata
  const r1 = await handleTaskAction(click({ actionId: "snooze_1h" }), sl.f, now);
  await r1.after();
  assert.equal((await state()).snoozed_until.toISOString(), "2026-10-07T21:00:00.000Z");
  const r2 = await handleTaskAction(click({ actionId: "snooze_tomorrow" }), sl.f, now);
  await r2.after();
  assert.equal((await state()).snoozed_until.toISOString(), "2026-10-09T03:30:00.000Z"); // 9 Oct 09:00 IST
  assert.equal(sl.updates.length, 2);
  assert.match(sl.updates[1].status, /Snoozed until 9 Oct 2026, 09:00/);
});

test("mark done: DM message updated; channel gets an ephemeral; repeat is harmless; no snooze after done", async () => {
  const sl = fake(emails());
  const done = await handleTaskAction(click({}), sl.f);
  await done.after();
  assert.equal(done.outcome, "done");
  const st = await state();
  assert.ok(st.done_at);
  assert.equal(st.snoozed_until, null); // done clears a pending snooze
  assert.match(sl.updates[0].status, /^✅ Done/);

  const again = await handleTaskAction(click({ channelId: "C0OPS" }), sl.f);
  await again.after();
  assert.equal(again.outcome, "done");
  assert.equal((await state()).done_at.getTime(), st.done_at.getTime()); // unchanged
  assert.equal(sl.updates.length, 1); // the shared channel message isn't touched
  assert.match(sl.ephemerals[0], /^✅ Done/);

  const snooze = await handleTaskAction(click({ actionId: "snooze_1h" }), sl.f);
  assert.equal(snooze.outcome, "done");
  assert.equal((await state()).snoozed_until, null);
});
