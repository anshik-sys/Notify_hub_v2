// PRD 14.7 browser push: saving a browser, and the worker's sender with a fake push service.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { MEMBER_ROLE_ID } from "@/lib/permissions";
import { setMutes } from "@/lib/notifications";
import { browserLabel, checkSubscription, removePushSubscription, savePushSubscription } from "@/lib/push";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { dispatchPush } from "./push";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
let alice: string, bob: string, reminderId: string;
const KEYS = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
const sub = (n: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${s.companyId}-${n}`, ...KEYS });
const sent: { endpoint: string; payload: { title: string; body: string; url: string; tag: string } }[] = [];
let fail: number | null = null;
const send = async (x: { endpoint: string }, payload: string) => {
  if (fail) throw Object.assign(new Error("push service says no"), { statusCode: fail });
  sent.push({ endpoint: x.endpoint, payload: JSON.parse(payload) });
};
const notify = async (userId: string, kind: string, text: string, ago = "0 minutes") =>
  (
    await q(
      `insert into notifications (company_id, user_id, kind, reminder_id, text, created_at) values ($1, $2, $3, $4, $5, now() - $6::interval) returning id`,
      [s.companyId, userId, kind, reminderId, text, ago],
    )
  )[0].id as string;
const run = () => dispatchPush(send as never, s.companyId);

before(async () => {
  await s.company();
  [alice, bob] = [await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] })];
  [{ id: reminderId }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local)
     values ($1, $2, $3, 'Quarterly review', 'S', now(), 'sent', 'UTC', '2026-01-01T00:00') returning id`,
    [s.companyId, `P-${s.companyId.slice(0, 8)}`, alice],
  );
  await savePushSubscription(s.companyId, alice, sub("a1"), "Chrome on macOS");
  await savePushSubscription(s.companyId, alice, sub("a2"), "Safari on macOS");
});
after(async () => {
  await q("delete from push_subscriptions where company_id = $1", [s.companyId]);
  await s.cleanup();
  await Promise.all([db.$client.end(), ownerDb.$client.end()]);
});

test("only known push services, https, with keys", () => {
  assert.ok("sub" in checkSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: KEYS }));
  assert.ok("sub" in checkSubscription({ endpoint: "https://web.push.apple.com/abc", keys: KEYS }));
  assert.ok("sub" in checkSubscription({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", keys: KEYS }));
  assert.ok("error" in checkSubscription({ endpoint: "http://fcm.googleapis.com/x", keys: KEYS }));
  assert.ok("error" in checkSubscription({ endpoint: "https://169.254.169.254/latest", keys: KEYS }));
  assert.ok("error" in checkSubscription({ endpoint: "https://evil.example/fcm.googleapis.com", keys: KEYS }));
  assert.ok("error" in checkSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "x", auth: "y" } }));
  assert.equal(browserLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0"), "Edge on macOS");
});

test("a new notification goes once to each of the person's browsers, opening its item", async () => {
  sent.length = 0;
  await run(); // anything left from setup
  sent.length = 0;
  const id = await notify(alice, "mention", "N mentioned you: please check");
  await notify(bob, "mention", "bob has no browser");
  await run();
  await run();
  assert.deepEqual(sent.map((x) => x.endpoint).sort(), [sub("a1").endpoint, sub("a2").endpoint]);
  assert.deepEqual(sent[0].payload, { title: "Quarterly review", body: "N mentioned you: please check", url: `${process.env.BETTER_AUTH_URL}/reminders/${reminderId}`, tag: id });
});

test("muted for push, or older than an hour: not pushed; reminders can't be muted", async () => {
  sent.length = 0;
  await setMutes(s.companyId, alice, ["mention:push"]);
  await notify(alice, "mention", "muted one");
  await notify(alice, "reminder", "S sent you a reminder");
  await notify(alice, "task", "old one", "2 hours");
  await run();
  assert.deepEqual(sent.map((x) => x.payload.body), ["S sent you a reminder", "S sent you a reminder"]);
  await setMutes(s.companyId, alice, []);
});

test("gone browsers are forgotten; a failing push service is retried, then given up", async () => {
  await run();
  sent.length = 0;
  fail = 500;
  const id = await notify(alice, "comment", "try again");
  await run();
  assert.deepEqual(await q("select pushed_at is null as open, push_attempts from notifications where id = $1", [id]), [{ open: true, push_attempts: 1 }]);
  await run();
  await run();
  assert.deepEqual(await q("select pushed_at is null as open, push_attempts from notifications where id = $1", [id]), [{ open: false, push_attempts: 2 }]);
  fail = 410;
  await notify(alice, "comment", "gone");
  await run();
  fail = null;
  assert.equal((await q("select 1 from push_subscriptions where user_id = $1", [alice])).length, 0);
});

test("turning off forgets only that browser", async () => {
  await savePushSubscription(s.companyId, bob, sub("b1"), "Chrome on Windows");
  await savePushSubscription(s.companyId, bob, sub("b2"), "Firefox on Windows");
  await removePushSubscription(s.companyId, alice, sub("b1").endpoint); // not alice's: nothing
  await removePushSubscription(s.companyId, bob, sub("b1").endpoint);
  assert.deepEqual((await q("select label from push_subscriptions where user_id = $1", [bob])).map((r) => r.label), ["Firefox on Windows"]);
});
