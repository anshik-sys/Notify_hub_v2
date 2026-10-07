import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { encrypt } from "@/lib/crypto";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { claimDigests, digestContent, digestOne } from "./digest";

const s = seeder();
let alice: string, bob: string, noSlack: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const at = (ist: string) => new Date(`${ist}+05:30`);
const NOW = at("2043-03-10T09:00");

before(async () => {
  await s.company();
  await q("update companies set time_zone = 'Asia/Kolkata' where id = $1", [s.companyId]);
  [alice, bob] = [await s.user(), await s.user()];
  noSlack = await s.user({ email: `noslack-${Date.now()}@${s.domain}` });
  await q(
    `insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id, digest_enabled, digest_time, digest_channel_ids, digest_user_ids)
     values ($1, $2, 'WS', $3, 'UBOT', false, '09:00', '{C0GENERAL,C0BROKEN}', $4)`,
    [s.companyId, `T-${s.companyId}`, encrypt("xoxb-test"), [alice, noSlack]],
  );
  const reminder = async (title: string, status: string, sendAt: Date, isTask: boolean) =>
    (
      await q(
        `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes)
         values ($1, $2, $3, $4, 'HR', $5, $6, 'Asia/Kolkata', '2043-01-01T00:00', $7, $8) returning id`,
        [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, alice, title, sendAt, status, isTask, isTask ? 60 : null],
      )
    )[0].id as string;
  const taskWith = async (title: string, status: string, done: [string, boolean][]) => {
    const id = await reminder(title, status, at("2043-03-08T09:00"), true);
    const [{ id: occ }] = await q(
      "insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, due_at) values ($1, $2, $3, 'sent', $4) returning id",
      [s.companyId, id, at("2043-03-08T09:00"), at("2043-03-08T10:00")],
    );
    for (const [u, isDone] of done)
      await q("insert into task_assignments (company_id, reminder_id, occurrence_id, user_id, done_at) values ($1, $2, $3, $4, $5)", [
        s.companyId,
        id,
        occ,
        u,
        isDone ? at("2043-03-08T11:00") : null,
      ]);
  };
  await taskWith("Half done", "sent", [
    [alice, true],
    [bob, false],
  ]);
  await taskWith("All done", "sent", [[alice, true]]);
  await taskWith("Cancelled one", "cancelled", [[bob, false]]);
  await reminder("Standup tomorrow", "scheduled", at("2043-03-11T08:00"), false); // in 23h
  await reminder("Too far", "scheduled", at("2043-03-11T10:00"), false); // in 25h
  await reminder("Paused one", "paused", at("2043-03-10T12:00"), false);
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
});

test("claimDigests: enabled only, at the local slot, once a day", async () => {
  assert.deepEqual(await claimDigests(NOW, s.companyId), []); // disabled
  await q("update slack_installations set digest_enabled = true where company_id = $1", [s.companyId]);
  assert.deepEqual(await claimDigests(at("2043-03-10T08:59"), s.companyId), []);
  assert.deepEqual(await claimDigests(NOW, s.companyId), [s.companyId]);
  assert.deepEqual(await claimDigests(at("2043-03-10T18:00"), s.companyId), []);
  assert.deepEqual(await claimDigests(at("2043-03-11T09:00"), s.companyId), [s.companyId]);
});

test("digestContent: overdue with someone not done; the next 24h only", async () => {
  const c = await digestContent(s.companyId, NOW);
  assert.equal(c.date, "10 Mar 2043");
  assert.deepEqual(c.overdue.map((o) => [o.title, o.detail]), [["Half done", "1 of 2 not done · due 8 Mar 2043, 10:00"]]);
  assert.deepEqual(c.upcoming.map((u) => u.title), ["Standup tomorrow"]);
});

test("digestOne: each channel and person independently; no Slack account skipped", async () => {
  const posts: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const p = init.body as URLSearchParams;
    const json = (b: object) => new Response(JSON.stringify(b));
    const method = url.split("/").pop();
    if (method === "users.lookupByEmail")
      return p.get("email")!.startsWith("noslack") ? json({ ok: false, error: "users_not_found" }) : json({ ok: true, user: { id: "UA" } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: "DA" } });
    if (method === "chat.postMessage") {
      if (p.get("channel") === "C0BROKEN") return json({ ok: false, error: "channel_not_found" });
      posts.push(`${p.get("channel")}: ${p.get("text")}`);
      return json({ ok: true, channel: p.get("channel"), ts: "1.0" });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  const r = await digestOne(s.companyId, f, NOW);
  assert.deepEqual(r.failed, ["C0BROKEN"]); // a broken channel didn't stop the rest
  assert.deepEqual(r.skipped.length, 1); // the person without Slack
  assert.deepEqual(posts.sort(), ["C0GENERAL: Daily digest: 1 overdue, 1 in the next 24 hours", "DA: Daily digest: 1 overdue, 1 in the next 24 hours"]);
});
