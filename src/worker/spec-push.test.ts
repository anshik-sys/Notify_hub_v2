// Behaviour tests for docs/expected-behaviour.md section 16, "Browser push
// notifications" (PU1–PU14). Written from the spec, not the code: a failure
// means one of them is wrong.
//
// The push service is a fake `send` handed to dispatchPush; each call is one
// worker run, always scoped to this file's company. Every test uses its own
// people and browser endpoints, and only looks at what reached its own
// endpoints, so leftovers from another test never count.
//
// Notification-centre rows are inserted through the owner connection (to set
// kind and created_at), except the mentions in PU7 and PU10, which come from a
// real comment (a mention needs "@Name" in the body; seeder names are the ids).
//
// Browser-only parts (the permission prompt, the service worker showing and
// clicking a notification, page wording) are skipped with the reason. PU10's
// click handling was checked by reading public/sw.js (see the skip's note).
import assert from "node:assert/strict";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { db, withTenant } from "@/db";
import { authDb } from "@/lib/auth";
import { addComment } from "@/lib/comments";
import { MUTABLE, openNotification, setMutes, unreadCount } from "@/lib/notifications";
import { COMPANY_ADMIN_ROLE_ID, loadAccess } from "@/lib/permissions";
import { exportPerson } from "@/lib/privacy";
import { browserLabel, checkSubscription, removePushSubscription, savePushSubscription } from "@/lib/push";
import { seeder } from "@/lib/test-helpers";
import { erasePerson, setActive } from "@/lib/users";
import { ownerDb } from "./db";
import { dispatchPush } from "./push";

const s = seeder();
const other = seeder();
type Seeder = typeof s;
const qIn = (co: Seeder) => async (sql: string, params: unknown[] = []) => (await co.owner.query(sql, params)).rows;
const q = qIn(s);

let admin: string;
const actor = async (id: string, co: Seeder = s) => ({ id, name: `PU-${id.slice(0, 6)}`, email: `${id}@${co.domain}`, access: await loadAccess(co.companyId, id) });

// A browser's PushSubscription.toJSON(): a unique endpoint and real-looking keys.
const browser = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
};
type Raw = ReturnType<typeof browser>;

// "Turn on" the server side does: check, then save for this person.
const turnOn = async (userId: string, raw: Raw = browser(), co: Seeder = s, label = "Chrome on macOS") => {
  const r = checkSubscription(raw);
  assert.ok("sub" in r, `a real browser subscription is accepted: ${JSON.stringify(r)}`);
  await savePushSubscription(co.companyId, userId, r.sub, label);
  return raw;
};

// The fake push service. `fail(endpoint)` returns an Error with statusCode to throw, or null.
type Call = { endpoint: string; keys: { p256dh: string; auth: string }; payload: string };
const pushService = (fail: (endpoint: string, n: number) => number | null = () => null) => {
  const calls: Call[] = [];
  const delivered: Call[] = [];
  const send = async (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => {
    const call = { endpoint: sub.endpoint, keys: sub.keys, payload };
    calls.push(call);
    const status = fail(sub.endpoint, calls.filter((c) => c.endpoint === sub.endpoint).length);
    if (status) throw Object.assign(new Error(`push service answered ${status}`), { statusCode: status });
    delivered.push(call);
    return { statusCode: 201 };
  };
  const to = (list: Call[], raw: Raw) => list.filter((c) => c.endpoint === raw.endpoint);
  return {
    send: send as unknown as Parameters<typeof dispatchPush>[0],
    calls,
    delivered,
    callsTo: (raw: Raw) => to(calls, raw),
    deliveredTo: (raw: Raw) => to(delivered, raw),
  };
};
type Payload = { title?: string; body?: string; url?: string; tag?: string };
const parse = (c: Call) => JSON.parse(c.payload) as Payload;
const run = (svc: ReturnType<typeof pushService>, now?: Date, co: Seeder = s) => dispatchPush(svc.send, co.companyId, now);

const reminder = async (o: { co?: Seeder; createdBy?: string; title?: string; description?: string; isTask?: boolean } = {}) => {
  const co = o.co ?? s;
  const shortId = `R-${randomUUID().slice(0, 10)}`;
  const title = o.title ?? `Push spec ${randomUUID().slice(0, 8)}`;
  const [{ id }] = await qIn(co)(
    `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes)
     values ($1, $2, $3, $4, $5, 'HR', '2050-01-15T09:00Z', 'scheduled', 'UTC', '2050-01-15T09:00', $6, $7) returning id`,
    [co.companyId, shortId, o.createdBy ?? (co === s ? admin : otherAdmin), title, o.description ?? "", o.isTask ?? false, o.isTask ? 60 : null],
  );
  return { id: id as string, shortId, title };
};
const note = async (o: { userId: string; kind: string; reminderId?: string | null; text?: string; createdAt?: Date; co?: Seeder }) => {
  const co = o.co ?? s;
  const [{ id }] = await qIn(co)(
    "insert into notifications (company_id, user_id, kind, reminder_id, text, created_at) values ($1, $2, $3, $4, $5, $6) returning id",
    [co.companyId, o.userId, o.kind, o.reminderId ?? null, o.text ?? `Line ${randomUUID().slice(0, 6)}`, o.createdAt ?? new Date()],
  );
  return id as string;
};
const subsOf = async (userId: string) => q("select endpoint, label from push_subscriptions where user_id = $1 order by created_at", [userId]);
const MIN = 60_000;

let otherAdmin: string;
before(async () => {
  await s.company();
  await other.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  otherAdmin = await other.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
});
after(async () => {
  for (const co of [s, other]) {
    await qIn(co)("delete from push_subscriptions where company_id = $1", [co.companyId]);
    await qIn(co)("delete from notifications where company_id = $1", [co.companyId]);
    await qIn(co)("delete from deliveries where company_id = $1", [co.companyId]);
  }
  await other.cleanup();
  await s.cleanup();
  await ownerDb.$client.end();
  await authDb.$client.end();
  await db.$client.end();
});

// --- Turning it on and off -------------------------------------------------------------------

test("PU1: turning push on saves this browser for you, and it then gets pushes", async () => {
  const alice = await s.user();
  const chrome = await turnOn(alice, browser(), s, browserLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"));
  const saved = await subsOf(alice);
  assert.equal(saved.length, 1, "this browser is saved for alice");
  assert.equal(saved[0].endpoint, chrome.endpoint);
  assert.match(saved[0].label, /Chrome/, `label names the browser: ${saved[0].label}`);
  assert.match(saved[0].label, /mac/i, `label names the OS: ${saved[0].label}`);
  assert.match(browserLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0"), /Firefox.*Windows|Windows.*Firefox/);

  // Turning on again in the same browser is still one browser.
  await turnOn(alice, chrome);
  assert.equal((await subsOf(alice)).length, 1, "the same browser saved twice is one browser");

  // A laptop and a desktop are two.
  const desktop = await turnOn(alice, browser(), s, "Edge on Windows");
  assert.equal((await subsOf(alice)).length, 2, "a second browser is a second subscription");

  const r = await reminder();
  await note({ userId: alice, kind: "reminder", reminderId: r.id });
  const svc = pushService();
  await run(svc);
  assert.equal(svc.deliveredTo(chrome).length, 1, "pushed to the first browser");
  assert.equal(svc.deliveredTo(desktop).length, 1, "pushed to the second browser");
  assert.deepEqual(svc.callsTo(chrome)[0].keys, chrome.keys, "sent with that browser's keys");
});

test("PU1: (browser) the permission prompt and the page saying it's on", { skip: "browser-only: Notification.requestPermission and the Preferences page wording; check in the browser" }, () => {});

test("PU2: a blocked permission saves nothing (server side: no subscription arrives, junk is refused)", async () => {
  const bob = await s.user();
  // A blocked browser has no subscription to send; whatever the page posts instead must not save.
  for (const raw of [null, undefined, {}, "", { endpoint: "" }, { endpoint: "https://push.example.test/x" }, { endpoint: "https://push.example.test/x", keys: {} }, { endpoint: "not a url", keys: browser().keys }]) {
    const r = checkSubscription(raw);
    assert.ok("error" in r, `refused: ${JSON.stringify(raw)} -> ${JSON.stringify(r)}`);
  }
  assert.equal((await subsOf(bob)).length, 0, "nothing saved");
});

test("PU2: (browser) the page explains how to allow it in site settings", { skip: "browser-only: permission denied state and page wording; check in the browser" }, () => {});

test("PU3: turning off forgets this browser only; your other browsers keep getting pushes", async () => {
  const carol = await s.user();
  const dan = await s.user();
  const laptop = await turnOn(carol);
  const desktop = await turnOn(carol);

  // Someone else can't turn off carol's browser.
  await removePushSubscription(s.companyId, dan, laptop.endpoint);
  assert.equal((await subsOf(carol)).length, 2, "dan removing carol's endpoint changes nothing");

  await removePushSubscription(s.companyId, carol, laptop.endpoint);
  assert.deepEqual((await subsOf(carol)).map((x) => x.endpoint), [desktop.endpoint], "only the laptop is forgotten");

  const r = await reminder();
  await note({ userId: carol, kind: "reminder", reminderId: r.id });
  const svc = pushService();
  await run(svc);
  assert.equal(svc.callsTo(laptop).length, 0, "the turned-off browser gets nothing");
  assert.equal(svc.deliveredTo(desktop).length, 1, "the other browser still gets it");
});

test("PU4: nobody has turned it on: nothing is pushed to anyone", async () => {
  const lone = seeder();
  await lone.company();
  try {
    const u1 = await lone.user();
    const u2 = await lone.user();
    const r = await reminder({ co: lone, createdBy: u1, title: "Nobody pushes" });
    for (const u of [u1, u2]) for (const kind of ["reminder", "mention", "approval"]) await note({ co: lone, userId: u, kind, reminderId: r.id });
    const svc = pushService();
    await run(svc, undefined, lone);
    assert.equal(svc.calls.length, 0, `no push service calls: ${JSON.stringify(svc.calls.map((c) => c.endpoint))}`);
  } finally {
    await qIn(lone)("delete from push_subscriptions where company_id = $1", [lone.companyId]);
    await lone.cleanup();
  }
});

test("PU4: (browser) nobody is asked for permission unprompted", { skip: "browser-only: no Notification.requestPermission without the person's click; check in the browser" }, () => {});

test("PU5: a browser the push service says is gone is forgotten at once, with no retries", async () => {
  const erin = await s.user();
  const gone = await turnOn(erin);
  const alive = await turnOn(erin);
  const svc = pushService((endpoint) => (endpoint === gone.endpoint ? 410 : null));
  const r = await reminder();
  await note({ userId: erin, kind: "reminder", reminderId: r.id });
  await run(svc);
  assert.equal(svc.callsTo(gone).length, 1, "tried once");
  assert.deepEqual((await subsOf(erin)).map((x) => x.endpoint), [alive.endpoint], "the gone browser is forgotten after that run");
  assert.equal(svc.deliveredTo(alive).length, 1, "the other browser still got it");

  // Later runs, and later notifications, never try it again.
  await note({ userId: erin, kind: "mention", reminderId: r.id });
  for (let i = 1; i <= 4; i++) await run(svc, new Date(Date.now() + i * 5 * MIN));
  assert.equal(svc.callsTo(gone).length, 1, "no retries to a gone browser");
  assert.equal(svc.deliveredTo(alive).length, 2, "the live browser got the second one too, once");
});

test("PU6: deactivating or erasing someone forgets their browsers; Download my data lists them without keys", async () => {
  const frank = await s.user();
  const gina = await s.user();
  const fb = await turnOn(frank, browser(), s, "Firefox on Windows");

  // Download my data: the browser and the date, never the keys.
  const exp = await exportPerson(s.companyId, frank);
  const text = JSON.stringify(exp);
  assert.ok(text.includes("Firefox on Windows"), `export lists the browser: ${text.slice(0, 400)}`);
  assert.ok(!text.includes(fb.keys.p256dh), "export has no p256dh key");
  assert.ok(!text.includes(fb.keys.auth), "export has no auth secret");
  // The entry with the label also carries a date.
  const find = (v: unknown): Record<string, unknown> | null => {
    if (Array.isArray(v)) {
      for (const x of v) {
        const f = find(x);
        if (f) return f;
      }
    } else if (v && typeof v === "object") {
      if (Object.values(v).includes("Firefox on Windows")) return v as Record<string, unknown>;
      for (const x of Object.values(v)) {
        const f = find(x);
        if (f) return f;
      }
    }
    return null;
  };
  const entry = find(JSON.parse(text));
  assert.ok(entry, "an export entry holds the browser label");
  assert.ok(
    Object.values(entry).some((x) => typeof x === "string" && x !== "Firefox on Windows" && !Number.isNaN(Date.parse(x))),
    `the entry has a date: ${JSON.stringify(entry)}`,
  );

  // Deactivated: forgotten, and nothing pushed to it.
  assert.equal(await setActive(await actor(admin), s.companyId, frank, false), null, "deactivated");
  assert.equal((await subsOf(frank)).length, 0, "a deactivated person's browsers are forgotten");

  // Erased (privacy): forgotten. Deactivated directly first, so the subscription is still there for erase to remove.
  await turnOn(gina);
  await q(`update "user" set deactivated_at = now() where id = $1`, [gina]);
  assert.equal((await subsOf(gina)).length, 1, "control: still saved before erasing");
  assert.equal(await erasePerson(await actor(admin), s.companyId, gina), null, "erased");
  assert.equal((await subsOf(gina)).length, 0, "an erased person's browsers are forgotten");
});

// --- What is pushed ----------------------------------------------------------------------------

const ALL_KINDS = ["reminder", "task", "approval", "mention", "comment", "decided", "tasks_done", "failed", "escalated", "rsvp", "invite", "calendar", "chain"];

test("PU7: everything new in your notification centre is pushed once to each of your browsers", async () => {
  const hana = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  const ivan = await s.user();
  const b1 = await turnOn(hana);
  const b2 = await turnOn(hana);
  const ivanB = await turnOn(ivan);
  const r = await reminder();
  const ids = [];
  for (const kind of ALL_KINDS) ids.push(await note({ userId: hana, kind, reminderId: r.id, text: `${kind} line` }));

  const svc = pushService();
  await run(svc);
  for (const b of [b1, b2]) {
    const bodies = svc.deliveredTo(b).map((c) => parse(c).body ?? "");
    for (const kind of ALL_KINDS) assert.equal(bodies.filter((x) => x.includes(`${kind} line`)).length, 1, `${kind} pushed once to ${b === b1 ? "browser 1" : "browser 2"}; got ${JSON.stringify(bodies)}`);
    assert.equal(bodies.length, ALL_KINDS.length, "nothing else");
  }
  assert.equal(svc.callsTo(ivanB).length, 0, "nothing of hana's goes to ivan's browser");

  // Later runs push nothing again.
  for (let i = 1; i <= 3; i++) await run(svc, new Date(Date.now() + i * 2 * MIN));
  assert.equal(svc.deliveredTo(b1).length, ALL_KINDS.length, "browser 1: still once each");
  assert.equal(svc.deliveredTo(b2).length, ALL_KINDS.length, "browser 2: still once each");

  // A real flow: hana mentioned in a comment by the admin.
  const res = await addComment(await actor(admin), s.companyId, r.id, { body: `@${hana} have a look please`, parentId: null, mentionIds: [hana] });
  assert.ok("id" in res, `comment posted: ${JSON.stringify(res)}`);
  const svc2 = pushService();
  await run(svc2);
  assert.equal(svc2.deliveredTo(b1).length, 1, `the mention is pushed to browser 1: ${JSON.stringify(svc2.calls.map((c) => c.payload))}`);
  assert.equal(svc2.deliveredTo(b2).length, 1, "and to browser 2");
});

test("PU7: (timing) within about a minute", { skip: "not a unit property: dispatchPush runs at the end of every worker dispatch, which the worker's `tick` schedules every minute (read in src/worker/index.ts)" }, () => {});

test("PU8: Preferences has a Push column for the same events, on by default; a muted event is not pushed; reminders, tasks and invites can't be muted", async () => {
  for (const m of MUTABLE) {
    assert.ok((m.channels as readonly string[]).includes("push"), `${m.event} has a push channel`);
    assert.ok(!(m.off as readonly string[]).includes("push"), `${m.event}: push starts on`);
  }
  for (const ev of ["reminder", "task", "invite"]) assert.ok(!MUTABLE.some((m) => m.event === ev), `${ev} is not on the Preferences page`);

  const jack = await s.user();
  const kim = await s.user();
  const jb = await turnOn(jack);
  const kb = await turnOn(kim);
  const r = await reminder();

  // Defaults: jack never opened Preferences; a comment and a mention are pushed.
  await note({ userId: jack, kind: "mention", reminderId: r.id, text: "default mention" });
  await note({ userId: jack, kind: "comment", reminderId: r.id, text: "default comment" });
  let svc = pushService();
  await run(svc);
  assert.deepEqual(svc.deliveredTo(jb).map((c) => parse(c).body).sort(), ["default comment", "default mention"], "both pushed by default");

  // Muting mention for push: no push for mentions; comments still pushed; email mutes don't touch push.
  await setMutes(s.companyId, jack, ["mention:push", "comment:email"]);
  // Trying to mute what can't be muted is ignored.
  await setMutes(s.companyId, kim, ["reminder:push", "task:push", "invite:push"]);
  await note({ userId: jack, kind: "mention", reminderId: r.id, text: "muted mention" });
  await note({ userId: jack, kind: "comment", reminderId: r.id, text: "unmuted comment" });
  for (const kind of ["reminder", "task", "invite"]) await note({ userId: kim, kind, reminderId: r.id, text: `kim ${kind}` });
  svc = pushService();
  await run(svc);
  assert.deepEqual(svc.deliveredTo(jb).map((c) => parse(c).body), ["unmuted comment"], "the muted mention is not pushed; the comment is");
  assert.deepEqual(svc.deliveredTo(kb).map((c) => parse(c).body).sort(), ["kim invite", "kim reminder", "kim task"], "reminders, tasks and invites are always pushed");

  // The muted one stays muted on later runs.
  await run(svc, new Date(Date.now() + 5 * MIN));
  assert.ok(!svc.deliveredTo(jb).some((c) => parse(c).body === "muted mention"), "never pushed later either");
});

test("PU8: (browser) the Push column on the Preferences page", { skip: "browser-only: the page layout; MUTABLE is checked above; check in the browser" }, () => {});

test("PU9: a push says the title, and the notification line cut to about 120 characters; no description", async () => {
  const lena = await s.user();
  const lb = await turnOn(lena);
  const r = await reminder({ title: "Quarterly safety check", description: "SECRET-DESCRIPTION-TEXT should never be pushed" });
  const short = "Alice mentioned you: can you check the fire doors?";
  const long = `Alice mentioned you: ${"the fire doors on floor three need a full check before Friday, ".repeat(6)}`;
  await note({ userId: lena, kind: "mention", reminderId: r.id, text: short });
  await note({ userId: lena, kind: "comment", reminderId: r.id, text: long });
  const svc = pushService();
  await run(svc);
  const got = svc.deliveredTo(lb).map(parse);
  assert.equal(got.length, 2, JSON.stringify(got));
  for (const p of got) {
    assert.equal(p.title, "Quarterly safety check", "title is the reminder's title");
    assert.ok((p.body ?? "").length <= 121, `body at most ~120 characters (${(p.body ?? "").length}): ${p.body}`);
  }
  for (const c of svc.deliveredTo(lb)) assert.ok(!c.payload.includes("SECRET-DESCRIPTION"), `no description in the push: ${c.payload}`);
  assert.equal(got.find((p) => p.body?.startsWith("Alice mentioned you: can"))?.body, short, "a short line is sent whole");
  const cut = got.find((p) => p.body !== short)!.body!;
  assert.ok(long.startsWith(cut.replace(/(…|\.\.\.)$/, "").trimEnd()), `a long line is its start, cut: ${cut}`);
  assert.ok(cut.length >= 100, `a long line keeps close to 120 characters: ${cut.length}`);

  // A task: title is the task's title.
  const t = await reminder({ title: "File the expense report", isTask: true });
  await note({ userId: lena, kind: "task", reminderId: t.id, text: "New task for you" });
  const svc2 = pushService();
  await run(svc2);
  assert.equal(parse(svc2.deliveredTo(lb)[0]).title, "File the expense report");
});

test("PU10: a push opens NotifyHub at the item, the comment's anchor for a mention", async () => {
  const mo = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  const mb = await turnOn(mo);
  const r = await reminder();
  const res = await addComment(await actor(admin), s.companyId, r.id, { body: `@${mo} look here`, parentId: null, mentionIds: [mo] });
  assert.ok("id" in res, JSON.stringify(res));
  const commentId = res.id as string;
  await note({ userId: mo, kind: "reminder", reminderId: r.id, text: "A reminder for you" });
  const svc = pushService();
  await run(svc);
  const got = svc.deliveredTo(mb).map(parse);
  assert.equal(got.length, 2, JSON.stringify(got));

  // Where a URL leads: straight to the item, or through the notification-centre click route.
  const destination = async (url: string | undefined) => {
    assert.ok(url, "the push carries a URL");
    const u = new URL(url, "http://notifyhub.local");
    const path = `${u.pathname}${u.hash}`;
    const m = /^\/notifications\/([0-9a-f-]{36})$/.exec(u.pathname);
    if (m) {
      const to = await openNotification(s.companyId, mo, m[1]);
      assert.ok(to, `the notification route opens somewhere: ${path}`);
      return new URL(to, "http://notifyhub.local");
    }
    return u;
  };
  const forReminder = got.find((p) => p.body === "A reminder for you")!;
  const forMention = got.find((p) => p !== forReminder)!;
  const toR = await destination(forReminder.url);
  assert.ok(toR.pathname.includes(r.id) || toR.pathname.includes(r.shortId), `the reminder push opens the reminder: ${toR.href}`);
  const toM = await destination(forMention.url);
  assert.ok(toM.pathname.includes(r.id) || toM.pathname.includes(r.shortId), `the mention push opens the reminder: ${toM.href}`);
  assert.equal(toM.hash, `#comment-${commentId}`, `the mention push opens at the comment: ${toM.href}`);
});

test(
  "PU10: (browser) clicking reuses an open NotifyHub tab, and signed out goes through sign-in",
  {
    skip:
      "browser-only. Read public/sw.js: notificationclick closes the notification, matches window clients of the same origin, focuses one and navigates it to data.url (falling back to openWindow), else openWindow(url). Signed out: the item page's requireMember redirects to /sign-in. Check in the browser.",
  },
  () => {},
);

test("PU11: nothing older than 1 hour is pushed (first turn-on, or after the worker was down)", async () => {
  const nina = await s.user();
  const r = await reminder();
  const now = new Date();
  await note({ userId: nina, kind: "reminder", reminderId: r.id, text: "two hours old", createdAt: new Date(now.getTime() - 120 * MIN) });
  await note({ userId: nina, kind: "reminder", reminderId: r.id, text: "61 minutes old", createdAt: new Date(now.getTime() - 61 * MIN) });
  await note({ userId: nina, kind: "reminder", reminderId: r.id, text: "30 minutes old", createdAt: new Date(now.getTime() - 30 * MIN) });
  // First turned on now: the backlog is older than the subscription.
  const nb = await turnOn(nina);
  const svc = pushService();
  await run(svc, now);
  assert.deepEqual(svc.deliveredTo(nb).map((c) => parse(c).body), ["30 minutes old"], "only the item from the last hour");

  // The worker was down: an item made while it was down is pushed only if still under an hour old when it runs.
  await note({ userId: nina, kind: "mention", reminderId: r.id, text: "while down", createdAt: now });
  const svc2 = pushService();
  await run(svc2, new Date(now.getTime() + 90 * MIN));
  assert.equal(svc2.deliveredTo(nb).length, 0, `nothing older than an hour when the worker comes back: ${JSON.stringify(svc2.calls.map((c) => c.payload))}`);
});

test("PU12: a failed push is tried again a few times, and never shown twice", async () => {
  const oscar = await s.user();
  const flaky = await turnOn(oscar);
  const steady = await turnOn(oscar);
  const r = await reminder();
  await note({ userId: oscar, kind: "reminder", reminderId: r.id, text: "retry me" });
  // The flaky browser's push service is down for the first attempt only.
  const svc = pushService((endpoint, n) => (endpoint === flaky.endpoint && n === 1 ? 500 : null));
  const start = Date.now();
  for (let i = 0; i <= 8; i++) await run(svc, new Date(start + i * 5 * MIN));
  assert.ok(svc.callsTo(flaky).length >= 2, `retried after a failure: ${svc.callsTo(flaky).length} call(s)`);
  assert.equal(svc.deliveredTo(flaky).length, 1, "delivered to the flaky browser exactly once");
  // The steady browser: never shown twice. A re-send (if any) must carry the same tag, which replaces the shown one.
  const steadyTags = svc.deliveredTo(steady).map((c) => parse(c).tag);
  assert.ok(steadyTags.length >= 1, "the steady browser got it");
  assert.ok(steadyTags[0], "the push has a tag");
  assert.ok(steadyTags.every((t) => t === steadyTags[0]), `every send of one item has the same tag: ${JSON.stringify(steadyTags)}`);
  assert.equal(parse(svc.deliveredTo(flaky)[0]).tag, steadyTags[0], "same tag on every browser for the same item");

  // Down for good: a few tries, then it stops (and the browser is not forgotten, it's not "gone").
  const paula = await s.user();
  const down = await turnOn(paula);
  await note({ userId: paula, kind: "reminder", reminderId: r.id, text: "never arrives" });
  const svc2 = pushService((endpoint) => (endpoint === down.endpoint ? 500 : null));
  const start2 = Date.now();
  for (let i = 0; i <= 10; i++) await run(svc2, new Date(start2 + i * 5 * MIN));
  const n = svc2.callsTo(down).length;
  assert.ok(n >= 2 && n <= 5, `tried a few times, then stopped: ${n} call(s)`);
  assert.equal((await subsOf(paula)).length, 1, "a 500 doesn't forget the browser");
});

test("PU13: a push doesn't mark anything read", async () => {
  const quinn = await s.user();
  const qb = await turnOn(quinn);
  const r = await reminder();
  const id = await note({ userId: quinn, kind: "reminder", reminderId: r.id });
  const before = await unreadCount(s.companyId, quinn);
  const svc = pushService();
  await run(svc);
  assert.equal(svc.deliveredTo(qb).length, 1, "control: pushed");
  assert.deepEqual(await q("select read_at from notifications where id = $1", [id]), [{ read_at: null }], "still unread after the push");
  assert.equal(await unreadCount(s.companyId, quinn), before, "unread count unchanged");
});

test("PU13: (browser) clicking the push opens the page, which reads it", { skip: "browser-only: the click is the service worker; the page/route marking read is unchanged behaviour; check in the browser" }, () => {});

test("PU14: pushes only go to your own browsers, for your own company's items", async () => {
  const rita = await s.user();
  const sam = await other.user();
  const rb = await turnOn(rita);
  const sb = await turnOn(sam, browser(), other);
  const r = await reminder();
  const ro = await reminder({ co: other });
  await note({ userId: rita, kind: "reminder", reminderId: r.id, text: "for rita" });
  await note({ co: other, userId: sam, kind: "reminder", reminderId: ro.id, text: "for sam" });

  // A run for our company never touches the other company's people or items.
  const svc = pushService();
  await run(svc);
  assert.deepEqual(svc.deliveredTo(rb).map((c) => parse(c).body), ["for rita"]);
  assert.equal(svc.callsTo(sb).length, 0, "nothing to another company's browser");
  assert.ok(!svc.calls.some((c) => c.payload.includes("for sam")), "another company's item isn't pushed by our run");

  // And the other company's run sends sam's only to sam.
  const svc2 = pushService();
  await run(svc2, undefined, other);
  assert.deepEqual(svc2.deliveredTo(sb).map((c) => parse(c).body), ["for sam"]);
  assert.equal(svc2.callsTo(rb).length, 0, "nothing of the other company's to rita");

  // Another company can't turn off our browser.
  await removePushSubscription(other.companyId, rita, rb.endpoint);
  assert.equal((await subsOf(rita)).length, 1, "rita's browser survives a removal from another company");

  // RLS: the web app's tenant connection sees only its own company's subscriptions.
  const seen = await withTenant(other.companyId, (tx) => tx.execute(`select user_id from push_subscriptions` as never));
  const rows = (seen as unknown as { rows: { user_id: string }[] }).rows;
  assert.ok(!rows.some((x) => x.user_id === rita), "another company's tenant can't see rita's browser");
});
