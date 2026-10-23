// Behaviour tests from docs/expected-behaviour.md section 14, "Sub-tasks"
// (ST1–ST12). Written from the spec, not the code: a failure means one of
// them is wrong.
//
// Tasks are made the way the New/Edit form makes them: a post -> formToRaw ->
// validateInput -> createReminder / updateReminder. Sub-task rows are
// sub.<i>.id / title / due / users. Most are made by olga (a Company Admin, so
// nothing waits for approval); ST8/ST9 use mia, a Member of the Ops department
// (alice, bob, dave; max is its manager; carol is outside it).
//
// Every date is in 2031 and every worker call gets an explicit `now`, so a
// live worker running against the same database never picks them up (except
// "Send now", which is real time by nature; see ST2). Sends are delivered to a
// fake mailer at once.
//
// How "the parent is done" is observed (ST4): the parent's occurrence's
// done_at (the single "done" of an occurrence nobody is assigned to, section
// 6), since the parent has no assignees of its own.
//
// Left for the browser: the "2 of 3 done" wording and layout on the parent's
// page, the link back on a sub-task's page, and what a viewer of the parent
// sees (count vs list).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "@/lib/auth";
import { connectGoogle } from "@/lib/google-calendar";
import type { sendMail } from "@/lib/mail";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "@/lib/permissions";
import {
  cancelReminder,
  checkCover,
  coverUrl,
  createReminder,
  decideReminder,
  deleteReminder,
  formToRaw,
  getReminder,
  listPendingApprovals,
  moveEntry,
  reminderAccess,
  setOccurrenceDone,
  updateReminder,
  validateInput,
} from "@/lib/reminders";
import { sendNow } from "@/lib/send-now";
import { myOpenTasks, setDone, subTasks } from "@/lib/tasks";
import { seeder } from "@/lib/test-helpers";
import { calendarRange } from "@/lib/views";
import { ownerDb } from "./db";
import { claimFollowUps, deliverOne, dispatchDue, dispatchRemindBefore, followUpOne } from "./delivery";
import { syncGoogle } from "./google-sync";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

let olga: string, alice: string, bob: string, carol: string, dave: string, mia: string, max: string;
const emailOf = (id: string) => `${id}@${s.domain}`;
const OUTSIDE = "partner@outside-st.example";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 86_400_000;
const local = (d: Date) => d.toISOString().slice(0, 16); // company zone is UTC
const PNG = new Uint8Array(
  Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000000970485973000003e8000003e801b57b526b00000012494441540899633891627422c5880142010028ae05799f5e3f950000000049454e44ae426082",
    "hex",
  ),
);

type Mail = Parameters<typeof sendMail>[0];
const capture = (box: Mail[]) => (async (m: Mail) => void box.push(m)) as unknown as typeof sendMail;
function fakeSlack() {
  const f = (async (url: string, init: RequestInit) => {
    const json = (b: object) => new Response(JSON.stringify(b));
    const p = init.body as URLSearchParams;
    const method = url.split("/").pop();
    if (method === "users.lookupByEmail") return json({ ok: true, user: { id: `U-${p.get("email")}` } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: `D-${p.get("users")}` } });
    if (method === "chat.postMessage") return json({ ok: true, channel: p.get("channel"), ts: "1.0" });
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  return { f };
}

// --- Making tasks through the form ----------------------------------------------

type Sub = { id?: string; title: string; due: Date; users?: string[] };
type TaskOpts = {
  title?: string;
  sendAt: Date;
  due: Date;
  users?: string[];
  emails?: string;
  repeat?: string;
  remind?: string[];
  subs?: Sub[];
};
const fields = (o: TaskOpts): [string, string][] => [
  ["title", o.title ?? "Onboarding"],
  ["description", "Welcome aboard."],
  ["senderName", ""],
  ...(o.users ?? [dave]).map((u): [string, string] => ["users", u]),
  ["emails", o.emails ?? ""],
  ["when", "later"],
  ["sendAt", local(o.sendAt)],
  ["repeat", o.repeat ?? "none"],
  ["every", "1"],
  ["unit", "week"],
  ["monthlyBy", "day"],
  ["ends", "never"],
  ["until", ""],
  ["count", ""],
  ["channels", "email"],
  ["tags", ""],
  ["kind", "task"],
  ["due", local(o.due)],
  ...(o.remind ?? []).map((m): [string, string] => ["remindBefore", m]),
  ["remindCustom", ""],
  ["remindUnit", "minutes"],
  ...(o.subs ?? []).flatMap((sub, i): [string, string][] => [
    [`sub.${i}.id`, sub.id ?? ""],
    [`sub.${i}.title`, sub.title],
    [`sub.${i}.due`, local(sub.due)],
    ...(sub.users ?? []).map((u): [string, string] => [`sub.${i}.users`, u]),
  ]),
];
const post = (f: [string, string][]) => {
  const fd = new FormData();
  for (const [k, v] of f) fd.append(k, v);
  return fd;
};
const parse = (o: TaskOpts) => {
  const r = validateInput(formToRaw(post(fields(o))), "UTC", "Alerts | Test Co", new Date(), []);
  return "error" in r ? { error: r.error as string, input: undefined } : { error: undefined, input: r.input! };
};
const actor = async (id = olga) => ({ id, email: emailOf(id), access: await loadAccess(s.companyId, id) });
async function make(o: TaskOpts, by = olga, coverRows: number[] = []) {
  const parsed = parse(o);
  if (parsed.error !== undefined) throw new Error(`form refused: ${parsed.error}`);
  for (const i of coverRows) {
    const c = checkCover("cover.png", PNG);
    assert.ok("image" in c);
    parsed.input!.subTasks![i].cover = c.image;
  }
  const r = await createReminder(await actor(by), s.companyId, parsed.input!);
  if ("error" in r) throw new Error(`not saved: ${r.error}`);
  return r.id as string;
}
async function task(o: TaskOpts, coverRows: number[] = []) {
  const id = await make(o, olga, coverRows);
  const [{ status }] = await q("select status from reminders where id = $1", [id]);
  assert.equal(status, "scheduled", "saved without approval");
  return id;
}
// A sub-task is stored titled "Laptop (Onboarding)"; its own title is "Laptop".
const own = (title: string) => title.replace(/ \([^()]*\)$/, "");
type SubRow = { id: string; title: string; status: string; due_after_minutes: number | null; send_at: Date; deleted_at: Date | null; is_task: boolean; parent_id: string };
// The live sub-tasks of a task, by their own title (a stored "Laptop (Onboarding)" is keyed "Laptop").
async function subsOf(parentId: string, withDeleted = false) {
  const rows = (await q(
    `select id, title, status, due_after_minutes, send_at, deleted_at, is_task, parent_id from reminders where parent_id = $1 ${withDeleted ? "" : "and deleted_at is null"} order by title`,
    [parentId],
  )) as SubRow[];
  return Object.fromEntries(rows.map((r) => [own(r.title), r])) as Record<string, SubRow>;
}

// --- The worker ---------------------------------------------------------------------

const allMail: Mail[] = [];
// One worker tick at `now`: a date coming round (delivered at once to a fake
// mailer), then remind-before (returned, not delivered).
async function tick(now: Date) {
  const sends: string[] = [];
  await dispatchDue(async (x) => void sends.push(...x), s.companyId, now);
  const sl = fakeSlack();
  for (const d of sends) await deliverOne(d, capture(allMail), sl.f);
  const ids: string[] = [];
  await dispatchRemindBefore(async (x) => void ids.push(...x), s.companyId, now);
  return ids;
}
const name = (u: string | null) =>
  u === null ? "outside" : ({ [olga]: "olga", [alice]: "alice", [bob]: "bob", [carol]: "carol", [dave]: "dave", [mia]: "mia", [max]: "max" }[u] ?? u);
// The people a reminder's (normal) sends went to, sorted.
const sentTo = async (id: string) =>
  ((await q("select user_id, address from deliveries where reminder_id = $1 and kind = 'reminder'", [id])) as { user_id: string | null; address: string }[])
    .map((r) => (r.user_id ? name(r.user_id) : r.address))
    .sort();
const assigneesOf = async (id: string) => ((await q("select user_id from task_assignments where reminder_id = $1", [id])) as { user_id: string }[]).map((r) => name(r.user_id)).sort();
const assignment = async (id: string, user: string) => (await q("select id from task_assignments where reminder_id = $1 and user_id = $2", [id, user]))[0]?.id as string;
const occurrence = async (id: string) =>
  (await q("select id, occurs_at, due_at, done_at from reminder_occurrences where reminder_id = $1 order by occurs_at", [id]))[0] as
    | { id: string; occurs_at: Date; due_at: Date | null; done_at: Date | null }
    | undefined;
type Due = { id: string; user_id: string | null; before_minutes: number; status: string };
const dueOf = async (id: string) => (await q("select id, user_id, before_minutes, status from deliveries where reminder_id = $1 and kind = 'due'", [id])) as Due[];
// Delivers queued "due soon" rows; returns "who:minutes" for those actually sent.
async function deliverDue(id: string) {
  for (const r of (await dueOf(id)).filter((r) => r.status === "queued")) await deliverOne(r.id, capture([]), fakeSlack().f);
  return (await dueOf(id))
    .filter((r) => r.status === "sent")
    .map((r) => `${name(r.user_id)}:${r.before_minutes}`)
    .sort();
}
const tasksDone = async (user: string) => (await q("select reminder_id, text from notifications where user_id = $1 and kind = 'tasks_done'", [user])) as { reminder_id: string; text: string }[];

before(async () => {
  await s.company();
  olga = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [alice, bob, carol, dave, mia, max] = await Promise.all(Array.from({ length: 6 }, () => s.user({ roles: [MEMBER_ROLE_ID] })));
  for (const [id, nm] of [
    [olga, "Olga"],
    [alice, "Alice"],
    [bob, "Bob"],
    [carol, "Carol"],
    [dave, "Dave"],
    [mia, "Mia"],
    [max, "Max"],
  ])
    await q(`update "user" set name = $2 where id = $1`, [id, nm]);
  const [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  for (const [u, mgr] of [
    [mia, false],
    [alice, false],
    [bob, false],
    [dave, false],
    [max, true],
  ] as const)
    await q("insert into department_members values ($1, $2, $3, $4)", [s.companyId, ops, u, mgr]);
});
after(async () => {
  await q("delete from google_calendars where user_id = any($1)", [[olga, alice, bob, carol, dave, mia, max]]);
  await q("delete from deliveries where company_id = $1", [s.companyId]);
  await q("delete from task_assignments where company_id = $1", [s.companyId]);
  await q("delete from reminder_occurrences where company_id = $1", [s.companyId]);
  await q("delete from reminder_covers where company_id = $1", [s.companyId]);
  await s.cleanup();
  await ownerDb.$client.end();
  await db.$client.end();
  await authDb.$client.end();
});

// --- ST1 -----------------------------------------------------------------------------

test("ST1: sub-tasks have their own title, assignees, due time and cover; saved and edited with the parent; only changed through it", async (t) => {
  const SEND = new Date("2031-01-06T09:00:00Z");
  const DUE = new Date(SEND.getTime() + 5 * DAY);
  const subs: Sub[] = [
    { title: "Laptop", due: new Date(SEND.getTime() + DAY), users: [alice] },
    { title: "Accounts", due: new Date(SEND.getTime() + 2 * DAY), users: [bob, carol] },
    { title: "Intro call", due: new Date(SEND.getTime() + 3 * DAY) },
  ];

  await t.test("created with the parent, each with its own title, due time and cover", async () => {
    const id = await task({ sendAt: SEND, due: DUE, users: [dave], subs }, [0]);
    const got = await subsOf(id);
    assert.deepEqual(Object.keys(got).sort(), ["Accounts", "Intro call", "Laptop"]);
    assert.ok(Object.values(got).every((r) => r.is_task && r.parent_id === id), "each is a task under the parent");
    assert.equal(got.Laptop.due_after_minutes, 1440);
    assert.equal(got.Accounts.due_after_minutes, 2880);
    assert.equal(got["Intro call"].due_after_minutes, 4320);
    assert.ok(await coverUrl(s.companyId, got.Laptop.id), "Laptop has its cover");
    assert.equal(await coverUrl(s.companyId, got.Accounts.id), null, "the others have none");
    assert.equal(await coverUrl(s.companyId, id), null, "the parent has none");
  });

  await t.test("each goes to its own assignees; one with nobody picked goes to the task's own recipients", async () => {
    const S2 = new Date("2031-01-08T09:00:00Z");
    const id = await task({ sendAt: S2, due: new Date(S2.getTime() + 5 * DAY), users: [dave], subs: subs.map((x) => ({ ...x, due: new Date(x.due.getTime() + 2 * DAY) })) });
    await tick(S2);
    const got = await subsOf(id);
    assert.deepEqual(await assigneesOf(got.Laptop.id), ["alice"]);
    assert.deepEqual(await assigneesOf(got.Accounts.id), ["bob", "carol"]);
    assert.deepEqual(await assigneesOf(got["Intro call"].id), ["dave"], "no assignees picked: the task's own recipients");
  });

  await t.test("edited with the parent: renamed, a cleared title removes it, a new row adds one", async () => {
    const S3 = new Date("2031-01-13T09:00:00Z");
    const d = (n: number) => new Date(S3.getTime() + n * DAY);
    const id = await task({ sendAt: S3, due: d(5), users: [dave], subs: [subs[0], subs[1], subs[2]].map((x, i) => ({ ...x, due: d(i + 1) })) }, [0]);
    const was = await subsOf(id);
    const edit = parse({
      sendAt: S3,
      due: d(5),
      users: [dave],
      subs: [
        { id: was.Laptop.id, title: "Laptop and phone", due: d(1), users: [alice] },
        { id: was.Accounts.id, title: "", due: d(2), users: [bob, carol] },
        { id: was["Intro call"].id, title: "Intro call", due: d(4) },
        { title: "Badge", due: d(2), users: [carol] },
      ],
    });
    assert.equal(edit.error, undefined, `the edit form accepted: ${edit.error}`);
    assert.equal(await updateReminder(await actor(), s.companyId, id, edit.input!), null);
    const now = await subsOf(id);
    assert.deepEqual(Object.keys(now).sort(), ["Badge", "Intro call", "Laptop and phone"]);
    assert.equal(now["Laptop and phone"].id, was.Laptop.id, "renamed in place");
    assert.ok(await coverUrl(s.companyId, was.Laptop.id), "its cover is kept (no new file)");
    assert.equal(now["Intro call"].id, was["Intro call"].id);
    assert.equal(now["Intro call"].due_after_minutes, 4 * 1440, "its due time changed");
    assert.notEqual(now.Badge.id, was.Accounts.id);
    await tick(S3);
    assert.deepEqual(await sentTo(was.Accounts.id), [], "the removed one is never sent");
    assert.deepEqual(await assigneesOf(now.Badge.id), ["carol"]);
  });

  await t.test("a sub-task can't be edited, moved, cancelled, deleted, sent now or approved on its own", async () => {
    const S4 = new Date("2031-01-20T09:00:00Z");
    const id = await task({ sendAt: S4, due: new Date(S4.getTime() + 5 * DAY), users: [dave], subs: [{ title: "Laptop", due: new Date(S4.getTime() + DAY), users: [alice] }] });
    const sub = (await subsOf(id)).Laptop;
    const me = await actor();
    const plain = parse({ title: "Laptop (edited alone)", sendAt: S4, due: new Date(S4.getTime() + DAY), users: [alice] });
    assert.equal(plain.error, undefined);
    assert.notEqual(await updateReminder(me, s.companyId, sub.id, plain.input!), null, "edit refused");
    const moved = await moveEntry(me, s.companyId, sub.id, S4, new Date(S4.getTime() + HOUR), "one");
    assert.ok("error" in moved, `move refused: ${JSON.stringify(moved)}`);
    assert.notEqual(await cancelReminder(me, s.companyId, sub.id), null, "cancel refused");
    assert.notEqual(await deleteReminder(me, s.companyId, sub.id), null, "delete refused");
    const sn = await sendNow(me, s.companyId, sub.id);
    assert.ok(sn.error, `send now refused: ${JSON.stringify(sn)}`);
    const after = (await subsOf(id)).Laptop;
    assert.ok(after, "still there");
    assert.equal(after.title, sub.title, "not renamed");
    assert.equal(after.status, "scheduled");
    assert.equal(after.send_at.getTime(), S4.getTime(), "not moved or sent now");

    // Approval: a task waiting for approval; its sub-task can't be approved alone.
    const pending = await make(
      { sendAt: S4, due: new Date(S4.getTime() + 5 * DAY), users: [alice], subs: [{ title: "Out of scope", due: new Date(S4.getTime() + DAY), users: [carol] }] },
      mia,
    );
    const psub = (await subsOf(pending))["Out of scope"];
    assert.equal(psub.status, "pending_approval", "the sub-task waits with its task");
    assert.notEqual(await decideReminder(me, s.companyId, psub.id, true), null, "approving the sub-task alone is refused");
    assert.equal((await subsOf(pending))["Out of scope"].status, "pending_approval");
    assert.equal((await q("select status from reminders where id = $1", [pending]))[0].status, "pending_approval");
  });
});

// --- ST2 -----------------------------------------------------------------------------

test("ST2: each sub-task goes out at the parent's send time (also after a move or Send now), to its own assignees, as 'Task: Laptop (Onboarding)'; the parent sends nothing", async (t) => {
  await t.test("at the send time", async () => {
    const SEND = new Date("2031-02-03T09:00:00Z");
    const id = await task({ sendAt: SEND, due: new Date(SEND.getTime() + 5 * DAY), users: [dave], subs: [
      { title: "Laptop", due: new Date(SEND.getTime() + DAY), users: [alice] },
      { title: "Accounts", due: new Date(SEND.getTime() + 2 * DAY), users: [bob] },
    ] });
    const sub = await subsOf(id);
    await tick(new Date(SEND.getTime() - MIN));
    assert.deepEqual(await sentTo(sub.Laptop.id), [], "nothing early");
    const mark = allMail.length;
    await tick(SEND);
    assert.deepEqual(await sentTo(sub.Laptop.id), ["alice"]);
    assert.deepEqual(await sentTo(sub.Accounts.id), ["bob"]);
    assert.deepEqual(await sentTo(id), [], "the parent sends nothing");
    assert.deepEqual(await assigneesOf(id), [], "the parent has no assignees");
    const mails = allMail.slice(mark);
    const toAlice = mails.filter((m) => m.to === emailOf(alice));
    assert.deepEqual(toAlice.map((m) => m.subject), ["Task: Laptop (Onboarding)"]);
    assert.deepEqual(mails.filter((m) => m.to === emailOf(bob)).map((m) => m.subject), ["Task: Accounts (Onboarding)"]);
    assert.deepEqual(mails.filter((m) => m.to === emailOf(dave)), [], "the parent's own recipients get nothing");
  });

  await t.test("after the parent is moved", async () => {
    const SEND = new Date("2031-02-10T09:00:00Z");
    const LATER = new Date(SEND.getTime() + 3 * HOUR);
    const id = await task({ sendAt: SEND, due: new Date(SEND.getTime() + 5 * DAY), users: [dave], subs: [{ title: "Laptop", due: new Date(SEND.getTime() + DAY), users: [alice] }] });
    const moved = await moveEntry(await actor(), s.companyId, id, SEND, LATER, "one");
    assert.ok("id" in moved, JSON.stringify(moved));
    const sub = (await subsOf(id)).Laptop;
    await tick(SEND);
    assert.deepEqual(await sentTo(sub.id), [], "not at the old time");
    await tick(LATER);
    assert.deepEqual(await sentTo(sub.id), ["alice"], "at the new time");
    assert.equal((await occurrence(sub.id))?.occurs_at.getTime(), LATER.getTime());
    assert.deepEqual(await sentTo(id), []);
  });

  await t.test("after Send now of the parent", async () => {
    const SEND = new Date("2031-02-17T09:00:00Z");
    const id = await task({ sendAt: SEND, due: new Date(SEND.getTime() + 5 * DAY), users: [dave], subs: [
      { title: "Laptop", due: new Date(SEND.getTime() + DAY), users: [alice] },
      { title: "Accounts", due: new Date(SEND.getTime() + DAY), users: [bob] },
    ] });
    const sub = await subsOf(id);
    const r = await sendNow(await actor(), s.companyId, id);
    assert.equal(r.error, undefined, JSON.stringify(r));
    // Real time: the live worker may get there first; either way the sends must exist.
    for (let i = 0; i < 20; i++) {
      const sends: string[] = [];
      await dispatchDue(async (x) => void sends.push(...x), s.companyId, new Date());
      for (const d of sends) await deliverOne(d, capture([]), fakeSlack().f);
      if ((await sentTo(sub.Laptop.id)).length && (await sentTo(sub.Accounts.id)).length) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.deepEqual(await sentTo(sub.Laptop.id), ["alice"]);
    assert.deepEqual(await sentTo(sub.Accounts.id), ["bob"]);
    assert.deepEqual(await sentTo(id), [], "the parent sends nothing");
  });
});

// --- ST3 -----------------------------------------------------------------------------

test("ST3: a sub-task's due time is its own: after the parent is sent and no later than the parent's due time", async (t) => {
  const SEND = new Date("2031-03-03T09:00:00Z");
  const DUE = new Date(SEND.getTime() + 5 * DAY);
  const withSub = (due: Date) => parse({ sendAt: SEND, due: DUE, users: [dave], subs: [{ title: "Laptop", due, users: [alice] }] });

  await t.test("refused: at or before sending, or after the parent's due time", () => {
    assert.ok(withSub(SEND).error, "at the send time");
    assert.ok(withSub(new Date(SEND.getTime() - HOUR)).error, "before the send time");
    assert.ok(withSub(new Date(DUE.getTime() + MIN)).error, "a minute after the parent's due time");
  });

  await t.test("accepted: just after sending, and exactly the parent's due time", () => {
    assert.equal(withSub(new Date(SEND.getTime() + MIN)).error, undefined);
    assert.equal(withSub(DUE).error, undefined);
  });

  await t.test("its own due time is the one used when sent", async () => {
    const id = await task({ sendAt: SEND, due: DUE, users: [dave], subs: [
      { title: "Laptop", due: new Date(SEND.getTime() + DAY), users: [alice] },
      { title: "Accounts", due: DUE, users: [bob] },
    ] });
    await tick(SEND);
    const sub = await subsOf(id);
    assert.equal((await occurrence(sub.Laptop.id))?.due_at?.getTime(), SEND.getTime() + DAY);
    assert.equal((await occurrence(sub.Accounts.id))?.due_at?.getTime(), DUE.getTime());
  });
});

// --- ST4 -----------------------------------------------------------------------------

test("ST4: a sub-task is done when all its assignees are (or the creator, sent only outside); the parent only when every sub-task is, and not after an un-mark", async (t) => {
  const SEND = new Date("2031-04-07T09:00:00Z");
  const id = await task({ sendAt: SEND, due: new Date(SEND.getTime() + 5 * DAY), users: [], emails: OUTSIDE, subs: [
    { title: "Laptop", due: new Date(SEND.getTime() + DAY), users: [alice, bob] },
    { title: "Contract", due: new Date(SEND.getTime() + DAY) }, // the task's own recipients: outside only
  ] });
  await tick(SEND);
  const sub = await subsOf(id);
  const done = async () => Object.fromEntries((await subTasks(s.companyId, id)).map((x) => [own(x.title), x.done]));
  const parentDone = async () => {
    const o = await occurrence(id);
    assert.ok(o, "the parent has an occurrence to carry its done state");
    return o.done_at !== null;
  };
  assert.deepEqual(await sentTo(sub.Contract.id), [OUTSIDE], "sent only outside");

  await t.test("the parent has no Mark done of its own", async () => {
    assert.deepEqual(await assigneesOf(id), []);
    const o = await occurrence(id);
    if (o) {
      assert.notEqual(await setOccurrenceDone(await actor(), s.companyId, o.id, true), null, "the creator can't mark the parent done");
      assert.equal((await occurrence(id))!.done_at, null);
    }
  });

  await t.test("all assignees of a sub-task: it's done; one of two: not", async () => {
    assert.equal(await setDone(alice, s.companyId, await assignment(sub.Laptop.id, alice), true), null);
    assert.equal((await done()).Laptop, false, "one of two");
    assert.equal(await parentDone(), false);
    assert.equal(await setDone(bob, s.companyId, await assignment(sub.Laptop.id, bob), true), null);
    assert.equal((await done()).Laptop, true, "both");
    assert.equal(await parentDone(), false, "not while Contract isn't done");
  });

  await t.test("sent only outside: the creator marks it done; then the parent is done", async () => {
    const o = await occurrence(sub.Contract.id);
    assert.ok(o);
    assert.equal(await setOccurrenceDone(await actor(), s.companyId, o.id, true), null);
    assert.equal((await done()).Contract, true);
    assert.equal(await parentDone(), true, "every sub-task done: the parent is");
  });

  await t.test("someone un-marks one: the parent stops being done", async () => {
    assert.equal(await setDone(bob, s.companyId, await assignment(sub.Laptop.id, bob), false), null);
    assert.equal((await done()).Laptop, false);
    assert.equal(await parentDone(), false);
  });
});

// --- ST5 -----------------------------------------------------------------------------

test("ST5: the parent's page lists its sub-tasks with how many are done and each one's people; a sub-task links back to the parent", async (t) => {
  const SEND = new Date("2031-05-05T09:00:00Z");
  const due = new Date(SEND.getTime() + DAY);
  const id = await task({ sendAt: SEND, due: new Date(SEND.getTime() + 5 * DAY), users: [dave], subs: [
    { title: "Laptop", due, users: [alice] },
    { title: "Accounts", due, users: [bob] },
    { title: "Intro call", due, users: [carol] },
  ] });
  await tick(SEND);
  const sub = await subsOf(id);
  assert.equal(await setDone(alice, s.companyId, await assignment(sub.Laptop.id, alice), true), null);
  assert.equal(await setDone(bob, s.companyId, await assignment(sub.Accounts.id, bob), true), null);

  const list = await subTasks(s.companyId, id);
  assert.deepEqual(list.map((x) => own(x.title)).sort(), ["Accounts", "Intro call", "Laptop"]);
  assert.equal(list.filter((x) => x.done).length, 2, "2 of 3 done");
  assert.equal(list.length, 3);
  const people = Object.fromEntries(list.map((x) => [own(x.title), x.people ?? ""]));
  assert.match(people.Laptop, /Alice/);
  assert.match(people.Accounts, /Bob/);
  assert.match(people["Intro call"], /Carol/);
  assert.doesNotMatch(people.Laptop, /Bob|Carol/);

  assert.equal((await getReminder(s.companyId, sub.Laptop.id))?.parentId, id, "a sub-task knows its parent (the link back)");
  await t.test("the page shows '2 of 3 done' and the link back", { skip: "browser: the parent's page wording and the sub-task page's link" }, () => {});
});

// --- ST6 -----------------------------------------------------------------------------

test("ST6: follow-ups and remind-before are per sub-task, to its own assignees not done; each uses the task's times that fall after it's sent", async (t) => {
  const SEND = new Date("2031-06-02T09:00:00Z");
  const SHORT = new Date(SEND.getTime() + 2 * HOUR);
  const LONG = new Date(SEND.getTime() + 3 * DAY);
  const id = await task({ sendAt: SEND, due: new Date(SEND.getTime() + 4 * DAY), users: [dave], remind: ["1440", "60"], subs: [
    { title: "Short", due: SHORT, users: [alice, bob] },
    { title: "Long", due: LONG, users: [bob] },
  ] });
  const sub = await subsOf(id);
  await tick(SEND);
  assert.equal(await setDone(bob, s.companyId, await assignment(sub.Short.id, bob), true), null);

  await t.test("remind before: a 2-hour sub-task gets '1 hour' only, to those not done", async () => {
    await tick(new Date(SHORT.getTime() - 60 * MIN));
    await tick(new Date(SHORT.getTime() - 30 * MIN));
    assert.deepEqual(await deliverDue(sub.Short.id), ["alice:60"]);
    assert.ok(!(await dueOf(sub.Short.id)).some((r) => r.before_minutes === 1440), "no '1 day' for it");
  });

  let claimed: string[] = [];
  await t.test("follow-ups: to the sub-task's own assignees not done, once overdue", async () => {
    claimed = await claimFollowUps(new Date(SHORT.getTime() + DAY - 2 * HOUR), s.companyId); // the next day, 09:00
    const mine = [await assignment(sub.Short.id, alice), await assignment(sub.Short.id, bob), await assignment(sub.Long.id, bob)];
    assert.deepEqual(
      claimed.filter((x) => mine.includes(x)),
      [mine[0]],
      "alice on Short only (bob is done; Long isn't overdue)",
    );
    const box: Mail[] = [];
    assert.equal(await followUpOne(mine[0], capture(box)), "sent");
    assert.equal(box[0]?.to, emailOf(alice));
    assert.match(box[0]?.subject ?? "", /^Overdue: .*Short/);
  });

  await t.test("the 3-day sub-task gets both, to its assignee", async () => {
    await tick(new Date(LONG.getTime() - 1440 * MIN));
    await tick(new Date(LONG.getTime() - 60 * MIN));
    assert.deepEqual(await deliverDue(sub.Long.id), ["bob:1440", "bob:60"].sort());
  });

  await t.test("the parent itself: none", async () => {
    assert.deepEqual(await dueOf(id), []);
    assert.deepEqual(await assigneesOf(id), [], "no assignees, so no follow-ups");
  });
});

// --- ST7 -----------------------------------------------------------------------------

test("ST7: the creator is told once, when the last sub-task is done ('Everyone has marked it done')", async () => {
  const SEND = new Date("2031-07-07T09:00:00Z");
  const due = new Date(SEND.getTime() + DAY);
  const id = await task({ sendAt: SEND, due: new Date(SEND.getTime() + 2 * DAY), users: [dave], subs: [
    { title: "Laptop", due, users: [alice] },
    { title: "Accounts", due, users: [bob, carol] },
  ] });
  await tick(SEND);
  const sub = await subsOf(id);
  const ours = async () => (await tasksDone(olga)).filter((n) => [id, sub.Laptop.id, sub.Accounts.id].includes(n.reminder_id));

  assert.equal(await setDone(alice, s.companyId, await assignment(sub.Laptop.id, alice), true), null);
  assert.deepEqual(await ours(), [], "not when Laptop alone is done");
  assert.equal(await setDone(bob, s.companyId, await assignment(sub.Accounts.id, bob), true), null);
  assert.deepEqual(await ours(), [], "not while carol isn't done");
  assert.equal(await setDone(carol, s.companyId, await assignment(sub.Accounts.id, carol), true), null);
  const told = await ours();
  assert.equal(told.length, 1, `once: ${JSON.stringify(told)}`);
  assert.match(told[0].text, /Everyone has marked it done/);
});

// --- ST8 -----------------------------------------------------------------------------

test("ST8: approved together: a sub-task out of the creator's scope makes the whole task wait, and nothing is sent until approved", async (t) => {
  const SEND = new Date("2031-08-04T09:00:00Z");
  const due = new Date(SEND.getTime() + DAY);
  const opts = (outsider: string): TaskOpts => ({ sendAt: SEND, due: new Date(SEND.getTime() + 2 * DAY), users: [alice], subs: [
    { title: "Laptop", due, users: [alice] },
    { title: "Accounts", due, users: [outsider] },
  ] });

  await t.test("control: all in scope (her department) is sent without approval", async () => {
    const id = await make(opts(bob), mia);
    assert.equal((await getReminder(s.companyId, id))?.status, "scheduled");
    assert.ok(Object.values(await subsOf(id)).every((x) => x.status === "scheduled"));
  });

  await t.test("one sub-task's assignee out of scope: parent and sub-tasks wait; nothing sent; approval sends them", async () => {
    const id = await make(opts(carol), mia);
    assert.equal((await getReminder(s.companyId, id))?.status, "pending_approval", "the whole task needs approval");
    const sub = await subsOf(id);
    assert.ok(Object.values(sub).every((x) => x.status === "pending_approval"), `sub-tasks wait too: ${JSON.stringify(Object.values(sub).map((x) => x.status))}`);
    const pending = (await listPendingApprovals(s.companyId)).map((x) => x.id);
    assert.ok(pending.includes(id), "the task is in the approvals list");
    assert.ok(!pending.includes(sub.Laptop.id) && !pending.includes(sub.Accounts.id), "its sub-tasks aren't listed apart from it");

    await tick(SEND);
    assert.deepEqual(await sentTo(sub.Laptop.id), [], "nothing sent, not even the in-scope sub-task");
    assert.deepEqual(await sentTo(sub.Accounts.id), []);

    const S2 = new Date(SEND.getTime() + 7 * DAY);
    const id2 = await make({ ...opts(carol), sendAt: S2, subs: opts(carol).subs!.map((x) => ({ ...x, due: new Date(S2.getTime() + DAY) })), due: new Date(S2.getTime() + 2 * DAY) }, mia);
    assert.equal(await decideReminder(await actor(), s.companyId, id2, true), null);
    const sub2 = await subsOf(id2);
    assert.ok(Object.values(sub2).every((x) => x.status === "scheduled"), "approved together");
    await tick(S2);
    assert.deepEqual(await sentTo(sub2.Laptop.id), ["alice"]);
    assert.deepEqual(await sentTo(sub2.Accounts.id), ["carol"]);
  });
});

// --- ST9 -----------------------------------------------------------------------------

test("ST9: each assignee sees their sub-task; the creator and overseers see all; the parent's own recipients see the parent, not the sub-tasks", async (t) => {
  const SEND = new Date("2031-09-01T09:00:00Z");
  const due = new Date(SEND.getTime() + DAY);
  const id = await make({ sendAt: SEND, due: new Date(SEND.getTime() + 2 * DAY), users: [dave], subs: [
    { title: "Laptop", due, users: [alice] },
    { title: "Accounts", due, users: [bob] },
  ] }, mia);
  assert.equal((await getReminder(s.companyId, id))?.status, "scheduled");
  await tick(SEND);
  const sub = await subsOf(id);
  const access = async (who: string, rid: string) => reminderAccess(s.companyId, await actor(who), { id: rid, createdBy: mia });

  await t.test("an assignee: their sub-task, not the other one", async () => {
    assert.notEqual(await access(alice, sub.Laptop.id), null);
    assert.equal(await access(alice, sub.Accounts.id), null);
    assert.notEqual(await access(bob, sub.Accounts.id), null);
    assert.equal(await access(bob, sub.Laptop.id), null);
  });

  await t.test("the creator and her manager (oversees her): everything in full", async () => {
    for (const who of [mia, max]) for (const rid of [id, sub.Laptop.id, sub.Accounts.id]) assert.equal(await access(who, rid), "full", `${name(who)} on ${rid === id ? "the parent" : "a sub-task"}`);
  });

  await t.test("the parent's own recipient: can view the parent, not the sub-tasks", async () => {
    assert.notEqual(await access(dave, id), null, "dave can view the parent");
    assert.notEqual(await access(dave, id), "full");
    assert.equal(await access(dave, sub.Laptop.id), null);
    assert.equal(await access(dave, sub.Accounts.id), null);
  });

  await t.test("someone else: nothing", async () => {
    for (const rid of [id, sub.Laptop.id, sub.Accounts.id]) assert.equal(await access(carol, rid), null);
  });

  await t.test("assignees see the parent's title and progress; viewers of the parent see the count, not the list", { skip: "browser: what the sub-task and parent pages show to each viewer" }, () => {});
});

// --- ST10 ----------------------------------------------------------------------------

test("ST10: only one level, only one-time tasks", async (t) => {
  const SEND = new Date("2031-10-06T09:00:00Z");
  const due = new Date(SEND.getTime() + DAY);

  await t.test("a repeating task can't have sub-tasks", () => {
    const r = parse({ sendAt: SEND, due: new Date(SEND.getTime() + 2 * DAY), repeat: "weekly", subs: [{ title: "Laptop", due, users: [alice] }] });
    assert.ok(r.error, "refused");
    assert.equal(parse({ sendAt: SEND, due: new Date(SEND.getTime() + 2 * DAY), repeat: "weekly" }).error, undefined, "control: without sub-tasks it's fine");
  });

  await t.test("a sub-task can't have sub-tasks", async () => {
    const id = await task({ sendAt: SEND, due: new Date(SEND.getTime() + 2 * DAY), subs: [{ title: "Laptop", due, users: [alice] }] });
    const sub = (await subsOf(id)).Laptop;
    const nested = parse({ title: "Laptop", sendAt: SEND, due, users: [alice], subs: [{ title: "Charger", due: new Date(SEND.getTime() + HOUR), users: [alice] }] });
    assert.equal(nested.error, undefined);
    await updateReminder(await actor(), s.companyId, sub.id, nested.input!);
    assert.deepEqual(Object.keys(await subsOf(sub.id, true)), [], "nothing saved under the sub-task");
  });
});

// --- ST11 ----------------------------------------------------------------------------

test("ST11: cancelling or deleting the parent takes its sub-tasks with it (no more follow-ups)", async (t) => {
  const mk = (SEND: Date) =>
    task({ sendAt: SEND, due: new Date(SEND.getTime() + 3 * DAY), users: [dave], remind: ["60"], subs: [
      { title: "Laptop", due: new Date(SEND.getTime() + 2 * HOUR), users: [alice] },
      { title: "Accounts", due: new Date(SEND.getTime() + 2 * HOUR), users: [bob] },
    ] });
  const quiet = async (SEND: Date, subIds: string[]) => {
    await tick(new Date(SEND.getTime() + HOUR)); // 1 hour before the sub-tasks' due
    for (const sid of subIds) assert.deepEqual(await deliverDue(sid), [], "no remind-before");
    const claimed = await claimFollowUps(new Date(SEND.getTime() + DAY), s.companyId);
    const theirs = (await q("select id from task_assignments where reminder_id = any($1)", [subIds])).map((r) => r.id as string);
    assert.deepEqual(claimed.filter((x) => theirs.includes(x)), [], "no follow-ups");
  };

  await t.test("cancel before sending: the sub-tasks are cancelled and never sent", async () => {
    const SEND = new Date("2031-11-03T09:00:00Z");
    const id = await mk(SEND);
    assert.equal(await cancelReminder(await actor(), s.companyId, id), null);
    const sub = await subsOf(id, true);
    assert.ok(Object.values(sub).every((x) => x.status === "cancelled"), JSON.stringify(Object.values(sub).map((x) => x.status)));
    await tick(SEND);
    for (const x of Object.values(sub)) assert.deepEqual(await sentTo(x.id), []);
  });

  // A one-time task already sent can't be cancelled today (it's deleted
  // instead); if cancelling is refused, its sub-tasks must not be cancelled on
  // their own either. If it's allowed, they go with it.
  await t.test("cancel after sending: the sub-tasks go with it (or, refused as for any sent task, all stay)", async () => {
    const SEND = new Date("2031-11-10T09:00:00Z");
    const id = await mk(SEND);
    await tick(SEND);
    const sub = await subsOf(id);
    assert.deepEqual(await sentTo(sub.Laptop.id), ["alice"]);
    const r = await cancelReminder(await actor(), s.companyId, id);
    const statuses = Object.values(await subsOf(id, true)).map((x) => x.status);
    if (r !== null) {
      assert.ok(!statuses.includes("cancelled"), `refused: no sub-task cancelled alone (${r}; ${JSON.stringify(statuses)})`);
      t.diagnostic(`cancel after sending refused: ${r}`);
      return;
    }
    assert.ok(statuses.every((x) => x === "cancelled"), JSON.stringify(statuses));
    await quiet(SEND, Object.values(sub).map((x) => x.id));
  });

  await t.test("delete after sending: the sub-tasks are deleted too; no more follow-ups", async () => {
    const SEND = new Date("2031-11-17T09:00:00Z");
    const id = await mk(SEND);
    await tick(SEND);
    const sub = await subsOf(id);
    assert.equal(await deleteReminder(await actor(), s.companyId, id), null);
    const gone = await subsOf(id, true);
    for (const x of Object.values(sub)) assert.ok(!gone[x.title] || (gone[x.title].deleted_at && gone[x.title].status === "cancelled"), `${x.title} deleted`);
    assert.equal(await getReminder(s.companyId, sub.Laptop.id), null, "not shown any more");
    await quiet(SEND, Object.values(sub).map((x) => x.id));
  });
});

// --- ST12 ----------------------------------------------------------------------------

test("ST12: calendar, Tasks page and Google show sub-tasks like tasks, titled 'Laptop (Onboarding)'; the parent once", async (t) => {
  const SEND = new Date("2031-12-01T09:00:00Z");
  const due = new Date(SEND.getTime() + DAY);
  const id = await task({ sendAt: SEND, due: new Date(SEND.getTime() + 2 * DAY), users: [dave], subs: [
    { title: "Laptop", due, users: [alice] },
    { title: "Accounts", due, users: [bob] },
  ] });
  const sub = await subsOf(id);
  const gAlice = fakeGoogle();
  const gOlga = fakeGoogle();
  assert.equal(await connectGoogle(s.companyId, alice, `code-${randomUUID()}`, gAlice.fetch), null);
  assert.equal(await connectGoogle(s.companyId, olga, `code-${randomUUID()}`, gOlga.fetch), null);
  await tick(SEND);
  const range = { from: local(new Date(SEND.getTime() - DAY)).slice(0, 10), to: local(new Date(SEND.getTime() + 3 * DAY)).slice(0, 10) };
  const entries = async (who: string) => [...((await calendarRange(s.companyId, await actor(who), "UTC", range))?.days.values() ?? [])].flat();

  await t.test("the calendar: the assignee's sub-task, titled with the parent", async () => {
    const mine = (await entries(alice)).filter((e) => [id, sub.Laptop.id, sub.Accounts.id].includes(e.reminderId));
    assert.deepEqual(mine.map((e) => e.title), ["Laptop (Onboarding)"]);
    assert.equal(mine[0].isTask, true);
  });

  await t.test("the calendar: the parent shows once", async () => {
    const all = await entries(olga);
    assert.equal(all.filter((e) => e.reminderId === id).length, 1, `parent entries: ${JSON.stringify(all.filter((e) => e.reminderId === id).map((e) => e.title))}`);
    for (const e of all.filter((e) => [sub.Laptop.id, sub.Accounts.id].includes(e.reminderId))) assert.match(e.title, /^(Laptop|Accounts) \(Onboarding\)$/);
  });

  await t.test("the Tasks page: the sub-task titled with the parent", async () => {
    const open = (await myOpenTasks(s.companyId, alice)).filter((x) => [id, sub.Laptop.id, sub.Accounts.id].includes(x.reminderId));
    assert.equal(open.length, 1);
    assert.equal(open[0].reminderId, sub.Laptop.id);
    assert.equal(open[0].title, "Laptop (Onboarding)");
  });

  await t.test("Google: the assignee's event is titled with the parent; the creator's has the parent once", async () => {
    assert.equal(await syncGoogle(alice, gAlice.fetch, new Date(SEND.getTime() - DAY)), "synced");
    assert.ok(gAlice.summaries(sub.Laptop.id).length > 0, "alice's sub-task is in her Google calendar");
    for (const x of gAlice.summaries(sub.Laptop.id)) assert.match(x, /Laptop \(Onboarding\)/);
    assert.deepEqual(gAlice.summaries(sub.Accounts.id), [], "not bob's sub-task");
    assert.equal(await syncGoogle(olga, gOlga.fetch, new Date(SEND.getTime() - DAY)), "synced");
    assert.ok(gOlga.summaries(id).length <= 1, `the parent at most once: ${JSON.stringify(gOlga.summaries(id))}`);
    const olgaSummaries = [...gOlga.summaries(sub.Laptop.id), ...gOlga.summaries(sub.Accounts.id)];
    for (const x of olgaSummaries.filter((x) => /Laptop|Accounts/.test(x))) assert.match(x, /(Laptop|Accounts) \(Onboarding\)/);
  });
});

// A minimal fake Google: token exchange, calendar create, event writes.
function fakeGoogle() {
  const calls: { method: string; url: string; body: string }[] = [];
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const email = `p${randomUUID().slice(0, 8)}@gmail.com`;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body ? String(init.body) : "";
    calls.push({ method, url, body });
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return json({
        access_token: `ya29.fake-${randomUUID()}`,
        expires_in: 3599,
        token_type: "Bearer",
        refresh_token: `1//fake-${randomUUID()}`,
        scope: "openid email https://www.googleapis.com/auth/calendar.app.created",
        id_token: `${b64({ alg: "RS256" })}.${b64({ iss: "https://accounts.google.com", sub: email, email, email_verified: true })}.sig`,
      });
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json({});
    const path = new URL(url).pathname.replace(/^\/calendar\/v3/, "");
    if (path === "/calendars" && method === "POST") return json({ id: `${randomUUID()}@group.calendar.google.com`, summary: "NotifyHub" });
    if (method === "GET" && path.endsWith("/events")) return json({ items: [] });
    if (method === "GET") return json({ error: { code: 404, message: "Not Found" } }, 404);
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json({ id: randomUUID().replace(/-/g, ""), ...JSON.parse(body || "{}") });
  }) as typeof fetch;
  return {
    fetch: f,
    // The titles written for one reminder (its page link is in the event).
    summaries: (reminderId: string) =>
      calls
        .filter(
          (c) =>
            c.url.startsWith("https://www.googleapis.com/calendar/v3") &&
            c.url.includes("/events") &&
            ["POST", "PUT", "PATCH"].includes(c.method) &&
            c.body.includes(`/reminders/${reminderId}`),
        )
        .map((c) => String((JSON.parse(c.body || "{}") as { summary?: string }).summary ?? "")),
  };
}
