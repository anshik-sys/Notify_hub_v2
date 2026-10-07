import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { encrypt } from "@/lib/crypto";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { claimFollowUps, claimSnoozes, deliverOne, dispatchDue, followUpOne, MAX_ATTEMPTS, snoozeOne, sweep } from "./delivery";

const s = seeder();
let reminderId: string;
let creator: string;
let alice: string;
const mailpit = async (to: string) =>
  (await (await fetch(`http://localhost:8025/api/v1/search?query=to:${encodeURIComponent(to)}`)).json()).messages_count as number;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const failingSend = async () => {
  throw new Error("SMTP down");
};

before(async () => {
  await s.company();
  creator = await s.user();
  alice = await s.user();
  const [bob, gone] = [await s.user(), await s.user()];
  await q(`update "user" set deactivated_at = now() where id = $1`, [gone]);
  const [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  for (const u of [alice, bob, gone]) await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, u]);
  [{ id: reminderId }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status, time_zone, anchor_local)
     values ($1, $2, $3, 'Fire drill', 'At 3pm', 'HR', now() + interval '1 hour', 'scheduled', 'UTC', '2026-01-01T00:00') returning id`,
    [s.companyId, `R-${s.companyId.slice(0, 6).toUpperCase()}`, creator],
  );
  await q("insert into reminder_targets values ($1, $2, 'department', $3), ($1, $2, 'email', $4)", [
    reminderId,
    s.companyId,
    ops,
    `ext@${s.domain}`,
  ]);
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
});

test("dispatch: parallel runs make one delivery per recipient", async () => {
  const enqueued: string[] = [];
  const enqueue = async (ids: string[]) => void enqueued.push(...ids);
  // "Now" is two hours ahead, so the reminder (due in 1h) is due for us but not for a live worker.
  const inTwoHours = new Date(Date.now() + 2 * 3_600_000);
  const [a, b] = await Promise.all([
    dispatchDue(enqueue, s.companyId, inTwoHours),
    dispatchDue(enqueue, s.companyId, inTwoHours),
  ]);
  assert.equal(a + b, 1); // one run got it, the other skipped the locked row
  const rows = await q("select address, status from deliveries where reminder_id = $1 order by address", [reminderId]);
  assert.equal(rows.length, 3); // alice, bob, ext (not the deactivated one)
  assert.equal(enqueued.length, 3);
  assert.deepEqual((await q("select status from reminders where id = $1", [reminderId]))[0], { status: "sending" });
  assert.equal(await dispatchDue(enqueue, s.companyId, inTwoHours), 0); // nothing left due
  const occ = await q("select status from reminder_occurrences where reminder_id = $1", [reminderId]);
  assert.deepEqual(occ, [{ status: "sending" }]);
});

test("deliver: one email even when claimed twice; retries then fails", async () => {
  const rows = await q("select id, address as email from deliveries where reminder_id = $1 order by address", [reminderId]);
  const [first, second, third] = rows;

  const results = await Promise.all([deliverOne(first.id), deliverOne(first.id)]);
  assert.deepEqual(results.sort(), ["sent", "skipped"]);
  assert.equal(await mailpit(first.email), 1);

  await assert.rejects(deliverOne(second.id, failingSend), /SMTP down/);
  assert.deepEqual(
    (await q("select status, attempts, last_error from deliveries where id = $1", [second.id]))[0],
    { status: "queued", attempts: 1, last_error: "SMTP down" },
  );
  await q("update deliveries set attempts = $2 where id = $1", [second.id, MAX_ATTEMPTS - 1]);
  assert.equal(await deliverOne(second.id, failingSend), "failed");
  assert.equal(await deliverOne(second.id), "skipped"); // failed is final

  assert.deepEqual((await q("select status from reminders where id = $1", [reminderId]))[0], { status: "sending" });
  assert.equal(await deliverOne(third.id), "sent");
  // Nothing in flight any more: the reminder is done.
  assert.deepEqual((await q("select status from reminders where id = $1", [reminderId]))[0], { status: "sent" });
  assert.deepEqual(await q("select status from reminder_occurrences where reminder_id = $1", [reminderId]), [{ status: "sent" }]);
});

test("sweep: stuck sends fail (never resent), old queued rows come back for re-enqueue", async () => {
  const [{ id: occ }] = await q("select id from reminder_occurrences where reminder_id = $1", [reminderId]);
  const [{ id: stuck }] = await q(
    `insert into deliveries (company_id, reminder_id, occurrence_id, address, status, attempts, updated_at)
     values ($1, $2, $3, $4, 'sending', 1, now() - interval '11 minutes') returning id`,
    [s.companyId, reminderId, occ, `stuck@${s.domain}`],
  );
  const [{ id: orphan }] = await q(
    `insert into deliveries (company_id, reminder_id, occurrence_id, address, status, updated_at)
     values ($1, $2, $3, $4, 'queued', now() - interval '3 minutes') returning id`,
    [s.companyId, reminderId, occ, `orphan@${s.domain}`],
  );
  const orphans = await sweep();
  assert.ok(orphans.includes(orphan));
  const [row] = await q("select status, last_error from deliveries where id = $1", [stuck]);
  assert.equal(row.status, "failed");
  assert.match(row.last_error, /Not resent/);
  assert.equal(await mailpit(`stuck@${s.domain}`), 0);
});

// A daily series anchored at a fixed UTC time; "now" for dispatch is passed
// explicitly, far in the future, so a live worker never sees these as due.
const series = async (title: string, anchor: string, rule: object, sendAt: string) => {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, recurrence)
     values ($1, $2, $3, $4, 'HR', $5, 'scheduled', 'UTC', $6, $7) returning id`,
    [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, creator, title, sendAt, anchor, JSON.stringify(rule)],
  );
  await q("insert into reminder_targets values ($1, $2, 'user', $3)", [id, s.companyId, alice]);
  return id as string;
};
const daily = { freq: "daily", interval: 1, end: { type: "never" } };
const occurrencesOf = async (id: string) =>
  (await q("select occurs_at, status from reminder_occurrences where reminder_id = $1 order by occurs_at", [id])).map(
    (o) => `${o.occurs_at.toISOString().slice(0, 16)} ${o.status}`,
  );

test("recurring: one occurrence per run, then advance; catch-up sends only the latest", async () => {
  const id = await series("Daily standup", "2040-01-01T09:00", daily, "2040-01-01T09:00Z");
  const enqueued: string[] = [];
  const enqueue = async (ids: string[]) => void enqueued.push(...ids);

  await dispatchDue(enqueue, s.companyId, new Date("2040-01-01T09:00:30Z"));
  assert.deepEqual(await occurrencesOf(id), ["2040-01-01T09:00 sending"]);
  const [r1] = await q("select status, send_at from reminders where id = $1", [id]);
  assert.deepEqual([r1.status, r1.send_at.toISOString()], ["scheduled", "2040-01-02T09:00:00.000Z"]); // next, still scheduled
  assert.equal(enqueued.length, 1);

  // Worker "down" until the 5th at 10:00: the 2nd, 3rd and 4th are missed, the 5th is sent.
  await dispatchDue(enqueue, s.companyId, new Date("2040-01-05T10:00:00Z"));
  assert.deepEqual(await occurrencesOf(id), [
    "2040-01-01T09:00 sending",
    "2040-01-02T09:00 missed",
    "2040-01-03T09:00 missed",
    "2040-01-04T09:00 missed",
    "2040-01-05T09:00 sending",
  ]);
  assert.equal(enqueued.length, 2); // one delivery each for the 1st and the 5th, none for missed ones
  const [r2] = await q("select send_at from reminders where id = $1", [id]);
  assert.equal(r2.send_at.toISOString(), "2040-01-06T09:00:00.000Z");

  // Parallel runs on the same due series: still one occurrence for the 6th.
  await Promise.all([
    dispatchDue(enqueue, s.companyId, new Date("2040-01-06T09:00:10Z")),
    dispatchDue(enqueue, s.companyId, new Date("2040-01-06T09:00:10Z")),
  ]);
  assert.equal((await occurrencesOf(id)).filter((o) => o.startsWith("2040-01-06")).length, 1);
  assert.equal(enqueued.length, 3);
  // Stop the series so the next test's far-future dispatch doesn't catch it up.
  await q("update reminders set status = 'cancelled' where id = $1", [id]);
});

test("recurring: a skipped occurrence isn't sent; a counted series ends", async () => {
  const id = await series("Twice", "2041-03-01T08:00", { ...daily, end: { type: "count", count: 2 } }, "2041-03-01T08:00Z");
  await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, '2041-03-01T08:00Z', 'skipped')", [
    s.companyId,
    id,
  ]);
  const enqueued: string[] = [];
  await dispatchDue(async (ids) => void enqueued.push(...ids), s.companyId, new Date("2041-03-01T08:00:05Z"));
  assert.equal(enqueued.length, 0); // skipped
  await dispatchDue(async (ids) => void enqueued.push(...ids), s.companyId, new Date("2041-03-02T08:00:05Z"));
  assert.equal(enqueued.length, 1);
  assert.deepEqual(await occurrencesOf(id), ["2041-03-01T08:00 skipped", "2041-03-02T08:00 sending"]);
  // Second (last) occurrence dispatched: the reminder is finishing.
  assert.deepEqual((await q("select status from reminders where id = $1", [id]))[0], { status: "sending" });
  assert.equal(await deliverOne(enqueued[0], async () => ({}) as never), "sent");
  assert.deepEqual((await q("select status from reminders where id = $1", [id]))[0], { status: "sent" });
});

test("tasks: due_at per occurrence; daily follow-ups at the company's local time", async () => {
  await q("update companies set time_zone = 'Asia/Kolkata', follow_up_time = '09:00' where id = $1", [s.companyId]);
  const bob = await s.user();
  const carol = await s.user();
  await q(`update "user" set deactivated_at = now() where id = $1`, [carol]);
  // A task sent 2042-05-01 08:00 IST, due 2 hours later (10:00 IST).
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes)
     values ($1, 'R-TASK42', $2, 'Expense report', 'HR', '2042-05-01T08:00+05:30', 'scheduled', 'Asia/Kolkata', '2042-05-01T08:00', true, 120) returning id`,
    [s.companyId, creator],
  );
  for (const u of [alice, bob, carol]) await q("insert into reminder_targets values ($1, $2, 'user', $3)", [id, s.companyId, u]);
  const ids: string[] = [];
  await dispatchDue(async (x) => void ids.push(...x), s.companyId, new Date("2042-05-01T02:31:00Z"));
  const [occ] = await q("select due_at from reminder_occurrences where reminder_id = $1", [id]);
  assert.equal(occ.due_at.toISOString(), "2042-05-01T04:30:00.000Z"); // 10:00 IST
  for (const d of ids) await deliverOne(d, async () => ({}) as never);
  const byUser = async (u: string) =>
    (await q("select id, followups from task_assignments where reminder_id = $1 and user_id = $2", [id, u]))[0];

  const claim = (ist: string) => claimFollowUps(new Date(`${ist}+05:30`), s.companyId);
  assert.deepEqual(await claim("2042-05-01T12:00"), []); // overdue, but today's 09:00 slot was before the due time
  assert.deepEqual(await claim("2042-05-02T08:59"), []); // before tomorrow's slot
  const day2 = await claim("2042-05-02T09:00");
  assert.deepEqual(day2.sort(), [(await byUser(alice)).id, (await byUser(bob)).id].sort()); // carol is deactivated
  assert.deepEqual(await claim("2042-05-02T15:00"), []); // once a day

  await q("update task_assignments set done_at = now() where id = $1", [(await byUser(bob)).id]);
  assert.deepEqual(await claim("2042-05-03T09:01"), [(await byUser(alice)).id]);
  assert.equal((await byUser(alice)).followups, 2);
  assert.equal((await byUser(bob)).followups, 1);

  const sent: string[] = [];
  const capture = async (m: { subject: string }) => void sent.push(m.subject);
  assert.equal(await followUpOne((await byUser(alice)).id, capture as never), "sent");
  assert.equal(await followUpOne((await byUser(bob)).id, capture as never), "skipped"); // done since
  assert.deepEqual(sent, ["Overdue: Expense report"]);
  await q("update reminders set status = 'cancelled' where id = $1", [id]);
});

// --- Slack ---------------------------------------------------------------------
// An in-process fake Slack: emails starting "noslack" have no account; a
// channel listed in rateLimitOnce answers 429 the first time.
function fakeSlack(rateLimitOnce = new Set<string>()) {
  const posts: { channel: string; text: string; actions: string[] }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const p = init.body as URLSearchParams;
    const json = (body: object, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers });
    if (method === "users.lookupByEmail")
      return p.get("email")!.startsWith("noslack") ? json({ ok: false, error: "users_not_found" }) : json({ ok: true, user: { id: "U1" } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: "D1" } });
    if (method === "chat.postMessage") {
      const channel = p.get("channel")!;
      if (rateLimitOnce.delete(channel)) return json({ ok: false }, 429, { "retry-after": "1" });
      if (channel === "C0GONE") return json({ ok: false, error: "channel_not_found" });
      const blocks = JSON.parse(p.get("blocks") ?? "[]") as { type: string; elements?: { action_id: string }[] }[];
      posts.push({ channel, text: p.get("text")!, actions: blocks.find((b) => b.type === "actions")?.elements?.map((e) => e.action_id) ?? [] });
      return json({ ok: true, channel, ts: `${posts.length}.0` });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  return { f, posts };
}

test("slack: DMs, channel posts, fallback, company-wide, 429 and permanent errors", async () => {
  const noSlack = await s.user({ email: `noslack-${Date.now()}@${s.domain}` });
  await q(
    "insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id, fallback_channel_id, fallback_channel_name) values ($1, $2, 'WS', $3, 'UBOT', 'C0FALL', 'fallback')",
    [s.companyId, `T-${s.companyId}`, encrypt("xoxb-test")],
  );
  const mk = async (title: string, channels: string, targets: [string, string | null, string | null][]) => {
    const [{ id }] = await q(
      `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, channels)
       values ($1, $2, $3, $4, 'HR', now() + interval '1 hour', 'scheduled', 'UTC', '2026-01-01T00:00', $5) returning id`,
      [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, creator, title, channels],
    );
    for (const [kind, ref, label] of targets) await q("insert into reminder_targets values ($1, $2, $3, $4, $5)", [id, s.companyId, kind, ref, label]);
    const ids: string[] = [];
    await dispatchDue(async (x) => void ids.push(...x), s.companyId, new Date(Date.now() + 2 * 3_600_000));
    return { id, ids };
  };
  const rowsOf = async (id: string) =>
    (await q("select channel, address, status, last_error from deliveries where reminder_id = $1 order by channel, address", [id])).map(
      (r) => `${r.channel}:${r.address === alice ? "alice" : r.address === noSlack ? "noslack" : r.address.includes("@") ? "email" : r.address} ${r.status}${r.last_error ? ` (${r.last_error})` : ""}`,
    ).sort();

  // Email + Slack to two people and a channel.
  const slack = fakeSlack(new Set(["C0OPS"]));
  const a = await mk("Both channels", "{email,slack}", [
    ["user", alice, null],
    ["user", noSlack, null],
    ["slack_channel", "C0OPS", "ops"],
  ]);
  assert.equal(a.ids.length, 5); // 2 emails, 2 DMs, 1 channel post
  for (const d of a.ids) await deliverOne(d, async () => ({}) as never, slack.f).catch(() => "retry");
  // The 429'd channel post is queued again; the retry sends it once.
  const [retry] = await q("select id from deliveries where reminder_id = $1 and status = 'queued'", [a.id]);
  assert.equal(await deliverOne(retry.id, async () => ({}) as never, slack.f), "sent");
  assert.deepEqual(await rowsOf(a.id), [
    "email:email sent",
    "email:email sent",
    "slack:C0OPS sent",
    "slack:alice sent",
    "slack:noslack sent (Sent to #fallback: not on Slack)",
  ]);
  assert.deepEqual(slack.posts.map((p) => p.channel).sort(), ["C0FALL", "C0OPS", "D1"]);
  assert.equal(slack.posts.filter((p) => p.channel === "C0OPS").length, 1);

  // No fallback channel: the person who isn't on Slack fails, permanently (no retry).
  await q("update slack_installations set fallback_channel_id = null where company_id = $1", [s.companyId]);
  const b = await mk("No fallback", "{slack}", [["user", noSlack, null]]);
  assert.equal(await deliverOne(b.ids[0], async () => ({}) as never, fakeSlack().f), "failed");
  assert.match((await rowsOf(b.id))[0], /No Slack account .* no fallback channel/);

  // Whole company on Slack: the channel only, never a DM to everyone.
  const c = await mk("Company", "{slack}", [
    ["company", null, null],
    ["slack_channel", "C0GENERAL", "general"],
  ]);
  assert.deepEqual(
    (await q("select channel, address from deliveries where reminder_id = $1", [c.id])).map((r) => `${r.channel}:${r.address}`),
    ["slack:C0GENERAL"],
  );

  // A deleted channel fails at once instead of retrying 5 times.
  const g = await mk("Gone", "{slack}", [["slack_channel", "C0GONE", "gone"]]);
  assert.equal(await deliverOne(g.ids[0], async () => ({}) as never, fakeSlack().f), "failed");
  assert.match((await rowsOf(g.id))[0], /channel_not_found/);
  for (const r of [a, b, c, g]) await q("update reminders set status = 'cancelled' where id = $1", [r.id]);
});

test("slack tasks: buttons on the first DM; follow-ups and snoozes as DMs", async () => {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, channels, is_task, due_after_minutes)
     values ($1, 'R-SLTASK', $2, 'Slack task', 'HR', now() + interval '1 hour', 'scheduled', 'UTC', '2026-01-01T00:00', '{slack}', true, 30) returning id`,
    [s.companyId, creator],
  );
  await q("insert into reminder_targets values ($1, $2, 'user', $3, null)", [id, s.companyId, alice]);
  const ids: string[] = [];
  await dispatchDue(async (x) => void ids.push(...x), s.companyId, new Date(Date.now() + 2 * 3_600_000));
  const sl = fakeSlack();
  await deliverOne(ids[0], async () => ({}) as never, sl.f);
  assert.deepEqual(sl.posts[0].actions, ["task_done", "snooze_1h", "snooze_tomorrow", "open"]);
  const [a] = await q("select id from task_assignments where reminder_id = $1", [id]);

  // A Slack-only task's follow-up is a DM with buttons (it used to be skipped).
  const mails: string[] = [];
  const mail = (async (m: { subject: string }) => void mails.push(m.subject)) as never;
  assert.equal(await followUpOne(a.id, mail, sl.f), "sent");
  assert.deepEqual(mails, []);
  assert.match(sl.posts[1].text, /^Overdue: this was due/);
  assert.deepEqual(sl.posts[1].actions, ["task_done", "snooze_1h", "snooze_tomorrow", "open"]);

  // Email + Slack: both; a Slack failure doesn't throw (or re-send the email).
  await q("update reminders set channels = '{email,slack}' where id = $1", [id]);
  const broken = (async () => {
    throw new Error("Slack down");
  }) as unknown as typeof fetch;
  assert.equal(await followUpOne(a.id, mail, broken), "sent");
  assert.deepEqual(mails, ["Overdue: Slack task"]);

  // Snoozes: due ones are claimed once; a done one isn't.
  await q("update task_assignments set snoozed_until = now() - interval '1 minute' where id = $1", [a.id]);
  assert.deepEqual(await claimSnoozes(new Date(), s.companyId), [a.id]);
  assert.deepEqual(await claimSnoozes(new Date(), s.companyId), []);
  assert.equal(await snoozeOne(a.id, sl.f), "sent");
  assert.ok(sl.posts[2].text.startsWith("Snoozed reminder: "));
  await q("update task_assignments set snoozed_until = now() - interval '1 minute', done_at = now() where id = $1", [a.id]);
  assert.deepEqual(await claimSnoozes(new Date(), s.companyId), []);
  assert.equal(await followUpOne(a.id, mail, sl.f), "skipped"); // done
  await q("update reminders set status = 'cancelled' where id = $1", [id]);
});
