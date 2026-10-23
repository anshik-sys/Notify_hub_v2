// Behaviour tests from docs/expected-behaviour.md section 14, "Remind before
// due" (RB1–RB9). Written from the spec, not the code: a failure means one of
// them is wrong.
//
// Tasks are made the way the New/Edit form makes them: a post -> formToRaw ->
// validateInput -> createReminder (as olga, a Company Admin, so nothing waits
// for approval). Every date is in 2031 and every worker call gets an explicit
// `now`, so a live worker running against the same database never picks them
// up. A "tick" runs what the worker runs each minute that matters here:
// dispatchDue (a date coming round; its own sends are delivered at once to a
// fake mailer so the live worker's orphan sweep never sends them) and then
// dispatchRemindBefore.
//
// Left for the browser: the form's default (1 day ticked only when the due
// time is more than a day after sending), the task page's list, and the edit
// form pre-filling the saved times.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import type { sendMail } from "@/lib/mail";
import { MUTABLE, setMutes } from "@/lib/notifications";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "@/lib/permissions";
import {
  cancelReminder,
  createReminder,
  deleteReminder,
  formToRaw,
  getReminder,
  moveEntry,
  setOccurrenceDone,
  skipNextOccurrence,
  updateReminder,
  validateInput,
} from "@/lib/reminders";
import { setDone } from "@/lib/tasks";
import { seeder } from "@/lib/test-helpers";
import { formatInZone } from "@/lib/time";
import { ownerDb } from "./db";
import { deliverOne, dispatchDue, dispatchRemindBefore } from "./delivery";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

let olga: string, alice: string, bob: string, carol: string;
const TEAM = () => `T-${s.companyId}`;
const emailOf = (id: string) => `${id}@${s.domain}`;
const OUTSIDE = "partner@outside-rb.example";
const MIN = 60_000;
const DAY = 86_400_000;
const local = (d: Date) => d.toISOString().slice(0, 16); // company zone is UTC

type Mail = Parameters<typeof sendMail>[0];
const capture = (box: Mail[]) => (async (m: Mail) => void box.push(m)) as unknown as typeof sendMail;

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

// --- Making tasks through the form ----------------------------------------------

type TaskOpts = {
  title?: string;
  sendAt: Date;
  due: Date;
  remind?: string[]; // remindBefore checkboxes
  custom?: string;
  unit?: string;
  users?: string[];
  emails?: string;
  channels?: string[];
  repeat?: string;
};
const fields = (o: TaskOpts): [string, string][] => [
  ["title", o.title ?? "File the report"],
  ["description", "Quarterly numbers."],
  ["senderName", ""],
  ...(o.users ?? [alice, bob]).map((u): [string, string] => ["users", u]),
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
  ...(o.channels ?? ["email"]).map((c): [string, string] => ["channels", c]),
  ["tags", ""],
  ["kind", "task"],
  ["due", local(o.due)],
  ...(o.remind ?? []).map((m): [string, string] => ["remindBefore", m]),
  ["remindCustom", o.custom ?? ""],
  ["remindUnit", o.unit ?? "minutes"],
];
const post = (f: [string, string][]) => {
  const fd = new FormData();
  for (const [k, v] of f) fd.append(k, v);
  return fd;
};
const parse = (o: TaskOpts) => {
  const r = validateInput(formToRaw(post(fields(o))), "UTC", "Alerts | Test Co", new Date(), []);
  return "error" in r ? { error: r.error, input: undefined } : { error: undefined, input: r.input };
};
const actor = async (id = olga) => ({ id, access: await loadAccess(s.companyId, id) });
async function task(o: TaskOpts) {
  const parsed = parse(o);
  if (parsed.error !== undefined) throw new Error(`form refused: ${parsed.error}`);
  const r = await createReminder(await actor(), s.companyId, parsed.input!);
  if ("error" in r) throw new Error(`not saved: ${r.error}`);
  const [{ status }] = await q("select status from reminders where id = $1", [r.id]);
  assert.equal(status, "scheduled", "saved without approval");
  return r.id;
}
const savedBefore = async (id: string) => ((await q("select notify_before from reminders where id = $1", [id]))[0].notify_before as number[]).slice().sort((a, b) => a - b);

// --- The worker ---------------------------------------------------------------------

// One worker tick at `now`; returns the "due soon" delivery ids it queued.
async function tick(now: Date) {
  const sends: string[] = [];
  await dispatchDue(async (x) => void sends.push(...x), s.companyId, now);
  const sl = fakeSlack();
  for (const d of sends) await deliverOne(d, capture([]), sl.f);
  const ids: string[] = [];
  await dispatchRemindBefore(async (x) => void ids.push(...x), s.companyId, now);
  return ids;
}
type Due = { id: string; channel: string; user_id: string | null; address: string; occurs_at: Date; before_minutes: number; status: string };
const dueOf = async (id: string) =>
  (await q(
    "select id, channel, user_id, address, occurs_at, before_minutes, status from deliveries where reminder_id = $1 and kind = 'due' order by created_at, before_minutes desc, channel, user_id",
    [id],
  )) as Due[];
const name = (u: string | null) => (u === null ? "outside" : ({ [olga]: "olga", [alice]: "alice", [bob]: "bob", [carol]: "carol" }[u] ?? u));
// "who:channel:minutes" per row, sorted.
const summary = (rows: Due[]) => rows.map((r) => `${name(r.user_id)}:${r.channel}:${r.before_minutes}`).sort();
const assignment = async (id: string, user: string, occursAt?: Date) =>
  (
    await q(
      `select a.id from task_assignments a join reminder_occurrences o on o.id = a.occurrence_id
        where a.reminder_id = $1 and a.user_id = $2 ${occursAt ? "and o.occurs_at = $3" : ""}`,
      occursAt ? [id, user, occursAt] : [id, user],
    )
  )[0]?.id as string;
// Delivers every queued row; returns what each person actually received.
async function deliverAll(rows: Due[]) {
  const got: Record<string, string> = {};
  for (const r of rows) {
    const box: Mail[] = [];
    const sl = fakeSlack();
    const result = await deliverOne(r.id, capture(box), sl.f);
    got[`${name(r.user_id)}:${r.channel}:${r.before_minutes}`] = `${result}, ${box.length + sl.posts.length} message(s)`;
  }
  return got;
}

before(async () => {
  await s.company();
  olga = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [alice, bob, carol] = [await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] })];
  for (const [id, nm] of [[olga, "Olga"], [alice, "Alice"], [bob, "Bob"], [carol, "Carol"]]) await q(`update "user" set name = $2 where id = $1`, [id, nm]);
  await q("insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'WS', $3, 'UBOT')", [
    s.companyId,
    TEAM(),
    encrypt("xoxb-test"),
  ]);
});
after(async () => {
  await q("delete from deliveries where company_id = $1", [s.companyId]);
  await q("delete from task_assignments where company_id = $1", [s.companyId]);
  await q("delete from reminder_occurrences where company_id = $1", [s.companyId]);
  await s.cleanup();
  await ownerDb.$client.end();
  await db.$client.end();
  await authDb.$client.end();
});

// --- RB1 -----------------------------------------------------------------------------

test("RB1: presets and a Custom time are saved with the task (1 day ticked by default is a browser check)", async (t) => {
  const SEND = new Date("2031-01-06T09:00:00Z");
  const DUE = new Date(SEND.getTime() + 10 * DAY);

  await t.test("presets and a custom number of minutes, hours or days", async () => {
    const id = await task({ sendAt: SEND, due: DUE, remind: ["60", "1440"], custom: "90", unit: "minutes" });
    assert.deepEqual(await savedBefore(id), [60, 90, 1440]);
    assert.deepEqual(((await getReminder(s.companyId, id))!.notifyBefore as number[]).slice().sort((a, b) => a - b), [60, 90, 1440], "what the task page reads");

    const hours = await task({ sendAt: SEND, due: DUE, remind: ["2880", "10080"], custom: "3", unit: "hours" });
    assert.deepEqual(await savedBefore(hours), [180, 2880, 10080], "3 hours = 180 minutes");
    const days = await task({ sendAt: SEND, due: DUE, remind: [], custom: "3", unit: "days" });
    assert.deepEqual(await savedBefore(days), [4320], "Custom alone: 3 days = 4320 minutes");
    const one = await task({ sendAt: SEND, due: DUE, remind: ["1440"] });
    assert.deepEqual(await savedBefore(one), [1440], "a single preset");
  });

  await t.test("nothing picked: none saved", async () => {
    const id = await task({ sendAt: SEND, due: DUE });
    assert.deepEqual(await savedBefore(id), []);
  });

  await t.test("1 day ticked by default when the due time is more than a day after sending, otherwise none; the task page lists them", { skip: "browser: the form's default ticks and the task page's list" }, () => {});
});

// --- RB2 -----------------------------------------------------------------------------

test("RB2: at the time, each assignee not done gets 'Due in 1 day: <title>' with the due time and Mark done, by email, Slack DM and in the app", async (t) => {
  const SEND = new Date("2031-02-03T09:00:00Z");
  const DUE = new Date("2031-02-05T09:00:00Z");
  const title = "Submit timesheet";
  const id = await task({ title, sendAt: SEND, due: DUE, remind: ["1440"], channels: ["email", "slack"], users: [alice, bob] });

  await tick(SEND);
  assert.deepEqual(await tick(new Date(DUE.getTime() - 1441 * MIN)), [], "nothing a minute early");
  assert.deepEqual(await dueOf(id), []);
  await tick(new Date(DUE.getTime() - 1440 * MIN));
  const rows = await dueOf(id);
  assert.deepEqual(summary(rows), ["alice:email:1440", "alice:slack:1440", "bob:email:1440", "bob:slack:1440"], "each assignee, each channel; not the creator");
  for (const r of rows.filter((r) => r.channel === "email")) assert.equal(r.address, emailOf(r.user_id!));

  const box: Mail[] = [];
  await t.test("the email: 'Due in 1 day: <title>' with the due time", async () => {
    assert.equal(await deliverOne(rows.find((r) => r.channel === "email" && r.user_id === alice)!.id, capture(box)), "sent");
    assert.equal(box.length, 1);
    assert.equal(box[0].to, emailOf(alice));
    const mail = `${box[0].subject}\n${box[0].text}`;
    assert.match(box[0].subject, /^Due in 1 day: Submit timesheet$/, `the subject: ${box[0].subject}`);
    assert.ok(mail.includes(formatInZone(DUE, "UTC")), `the due time (${formatInZone(DUE, "UTC")}) in: ${mail}`);
    assert.ok((box[0].links ?? []).some((l) => l.url.endsWith(`/reminders/${id}`)), `a link to the task: ${JSON.stringify(box[0].links)}`);
  });

  await t.test("the email: Mark done", async () => {
    const links = box[0]?.links ?? [];
    assert.ok(links.some((l) => /mark.*done/i.test(l.label)), `a Mark done link: ${JSON.stringify(links)}`);
  });

  await t.test("the Slack DM, with the Mark done button", async () => {
    const sl = fakeSlack();
    assert.equal(await deliverOne(rows.find((r) => r.channel === "slack" && r.user_id === bob)!.id, undefined, sl.f), "sent");
    assert.equal(sl.posts.length, 1);
    assert.match(sl.posts[0].blocks, /Mark done/, "a Mark done button");
    assert.match(sl.posts[0].blocks, /task_done/, "the Mark done button is the task's");
    assert.ok(sl.posts[0].text.includes(formatInZone(DUE, "UTC")), "the due time");
    assert.match(sl.posts[0].text, /^Due in 1 day: Submit timesheet\b/, "reads 'Due in 1 day: <title>'");
  });

  await t.test("in the app", async () => {
    await deliverAll((await dueOf(id)).filter((r) => r.status === "queued"));
    for (const who of [alice, bob]) {
      const notes = await q("select text from notifications where user_id = $1 and reminder_id = $2", [who, id]);
      assert.ok(
        notes.some((n) => /due in 1 day/i.test(n.text)),
        `${name(who)} has an in-app "Due in 1 day" notification: ${JSON.stringify(notes.map((n) => n.text))}`,
      );
    }
    const olgaNotes = await q("select text from notifications where user_id = $1 and reminder_id = $2", [olga, id]);
    assert.ok(!olgaNotes.some((n) => /due in/i.test(n.text)), "the creator (not an assignee) isn't told");
  });
});

// --- RB3 -----------------------------------------------------------------------------

test("RB3: nothing for someone already done, or a cancelled, deleted or skipped task (checked again just before sending)", async (t) => {
  await t.test("marked done before the time: nothing for them; the others still get it", async () => {
    const SEND = new Date("2031-03-03T09:00:00Z");
    const DUE = new Date("2031-03-05T09:00:00Z");
    const id = await task({ sendAt: SEND, due: DUE, remind: ["1440"], users: [alice, bob] });
    await tick(SEND);
    assert.equal(await setDone(alice, s.companyId, await assignment(id, alice), true), null);
    await tick(new Date(DUE.getTime() - 1440 * MIN));
    const got = await deliverAll(await dueOf(id));
    assert.equal(got["bob:email:1440"], "sent, 1 message(s)", JSON.stringify(got));
    assert.ok(!got["alice:email:1440"] || !/^sent|, [1-9]/.test(got["alice:email:1440"]), `alice (done) gets nothing: ${JSON.stringify(got)}`);
  });

  await t.test("marked done after it was queued, before it goes: not sent", async () => {
    const SEND = new Date("2031-03-10T09:00:00Z");
    const DUE = new Date("2031-03-12T09:00:00Z");
    const id = await task({ sendAt: SEND, due: DUE, remind: ["1440"], users: [alice, bob], channels: ["email", "slack"] });
    await tick(SEND);
    await tick(new Date(DUE.getTime() - 1440 * MIN));
    assert.deepEqual(summary(await dueOf(id)), ["alice:email:1440", "alice:slack:1440", "bob:email:1440", "bob:slack:1440"], "queued for both");
    assert.equal(await setDone(alice, s.companyId, await assignment(id, alice), true), null);
    const got = await deliverAll(await dueOf(id));
    for (const k of ["alice:email:1440", "alice:slack:1440"]) assert.doesNotMatch(got[k], /^sent|, [1-9]/, `${k}: not sent (all: ${JSON.stringify(got)})`);
    for (const k of ["bob:email:1440", "bob:slack:1440"]) assert.equal(got[k], "sent, 1 message(s)", `${k} (all: ${JSON.stringify(got)})`);
  });

  await t.test("cancelled: nothing queued; queued then cancelled: not sent", async () => {
    const SEND = new Date("2031-03-17T09:00:00Z");
    const DUE = new Date(SEND.getTime() + 3 * 60 * MIN);
    const mk = () => task({ sendAt: SEND, due: DUE, remind: ["60"], users: [alice], repeat: "daily" });
    const [early, late] = [await mk(), await mk()];
    await tick(SEND);
    assert.equal(await cancelReminder(await actor(), s.companyId, early), null);
    await tick(new Date(DUE.getTime() - 60 * MIN));
    assert.deepEqual(await dueOf(early), [], "cancelled before the time: nothing queued");
    const rows = await dueOf(late);
    assert.deepEqual(summary(rows), ["alice:email:60"]);
    assert.equal(await cancelReminder(await actor(), s.companyId, late), null);
    const got = await deliverAll(rows);
    assert.doesNotMatch(got["alice:email:60"], /^sent|, [1-9]/, `queued then cancelled: not sent (${JSON.stringify(got)})`);
  });

  await t.test("deleted: nothing queued; queued then deleted: not sent", async () => {
    const SEND = new Date("2031-03-24T09:00:00Z");
    const DUE = new Date("2031-03-26T09:00:00Z");
    const mk = () => task({ sendAt: SEND, due: DUE, remind: ["1440"], users: [alice] });
    const [early, late] = [await mk(), await mk()];
    await tick(SEND); // sent (and its emails delivered), so it can be deleted
    assert.equal(await deleteReminder(await actor(), s.companyId, early), null);
    await tick(new Date(DUE.getTime() - 1440 * MIN));
    assert.deepEqual(await dueOf(early), [], "deleted before the time: nothing queued");
    const rows = await dueOf(late);
    assert.deepEqual(summary(rows), ["alice:email:1440"]);
    // Deleting through the app refuses while something is queued; the state
    // after a delete is what matters here.
    await q("update reminders set deleted_at = now(), status = 'cancelled' where id = $1", [late]);
    const got = await deliverAll(rows);
    assert.doesNotMatch(got["alice:email:1440"], /^sent|, [1-9]/, `queued then deleted: not sent (${JSON.stringify(got)})`);
  });

  await t.test("a skipped date of a repeating task: nothing for that date", async () => {
    const SEND = new Date("2031-04-07T09:00:00Z");
    const id = await task({ sendAt: SEND, due: new Date(SEND.getTime() + 3 * 60 * MIN), remind: ["60"], users: [alice], repeat: "daily" });
    await tick(SEND); // date 1 sent; next is date 2
    assert.equal(await skipNextOccurrence(await actor(), s.companyId, id), null); // skips date 2
    // Date 4 skipped because a "this one" copy replaces it (dispatchDue records it with its due time).
    const d4 = new Date(SEND.getTime() + 3 * DAY);
    await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, due_at) values ($1, $2, $3, 'skipped', $4)", [
      s.companyId,
      id,
      d4,
      new Date(d4.getTime() + 3 * 60 * MIN),
    ]);
    for (let d = 0; d < 5; d++) {
      const date = SEND.getTime() + d * DAY;
      if (d) await tick(new Date(date));
      await tick(new Date(date + 2 * 60 * MIN)); // 1 hour before due
      await tick(new Date(date + 2 * 60 * MIN + 30 * MIN));
    }
    const rows = await dueOf(id);
    const at = (d: number, plus = 0) => SEND.getTime() + d * DAY + plus;
    const skipped = [at(1), at(1, 3 * 60 * MIN), at(3), at(3, 3 * 60 * MIN)];
    const dates = [...new Set(rows.map((r) => new Date(r.occurs_at).getTime()))];
    assert.ok(!dates.some((x) => skipped.includes(x)), `nothing for the skipped dates (2 and 4): ${dates.map((x) => new Date(x).toISOString())}`);
    assert.equal(dates.length, 3, `dates 1, 3 and 5 each get one: ${dates.map((x) => new Date(x).toISOString())}`);
    assert.equal(rows.length, 3);
  });
});

// --- RB4 -----------------------------------------------------------------------------

test("RB4: 1 week and 1 day: each once per assignee per date, in time order; a late worker sends only the nearest one still due", async (t) => {
  const subjects: string[] = [];
  await t.test("on time", async () => {
    const SEND = new Date("2031-05-05T09:00:00Z");
    const DUE = new Date(SEND.getTime() + 9 * DAY);
    const at = (min: number) => new Date(DUE.getTime() - min * MIN);
    const id = await task({ title: "Renew contract", sendAt: SEND, due: DUE, remind: ["10080", "1440"], users: [alice, bob] });
    await tick(SEND);
    await tick(at(10081));
    assert.deepEqual(summary(await dueOf(id)), [], "nothing before the first is due");
    await tick(at(10080));
    assert.deepEqual(summary(await dueOf(id)), ["alice:email:10080", "bob:email:10080"], "the week-before ones first, alone");
    await tick(at(10080));
    await tick(at(5000));
    await tick(at(1441));
    assert.deepEqual(summary(await dueOf(id)), ["alice:email:10080", "bob:email:10080"], "not again on later runs");
    await tick(at(1440));
    await tick(at(1440));
    await tick(at(600));
    assert.deepEqual(summary(await dueOf(id)), ["alice:email:10080", "alice:email:1440", "bob:email:10080", "bob:email:1440"], "then the day-before ones, once");

    const rows = await dueOf(id);
    const mine = rows.filter((r) => r.user_id === alice);
    assert.deepEqual(mine.map((r) => r.before_minutes), [10080, 1440], "queued in time order");
    for (const r of mine) {
      const box: Mail[] = [];
      assert.equal(await deliverOne(r.id, capture(box)), "sent");
      subjects.push(box[0].subject);
    }
    assert.equal(await deliverOne(mine[0].id, capture([])), "skipped", "a retry doesn't send twice");
  });

  // The preset is called "1 week before due" (RB1); RB2's wording is "Due in 1 day".
  await t.test("the wording of each: 'Due in 1 week', 'Due in 1 day'", () => {
    assert.deepEqual(subjects, ["Due in 1 week: Renew contract", "Due in 1 day: Renew contract"]);
  });

  await t.test("late worker: only the nearest one still due, never '1 week' a day before", async () => {
    const SEND = new Date("2031-05-19T09:00:00Z");
    const DUE = new Date(SEND.getTime() + 9 * DAY);
    const id = await task({ title: "Late one", sendAt: SEND, due: DUE, remind: ["10080", "1440"], users: [alice] });
    await tick(SEND);
    // The worker was down from before the week-before time until after the day-before time.
    await tick(new Date(DUE.getTime() - 1400 * MIN));
    await tick(new Date(DUE.getTime() - 1000 * MIN));
    assert.deepEqual(summary(await dueOf(id)), ["alice:email:1440"], "only the 1-day one");
    const box: Mail[] = [];
    const [r] = await dueOf(id);
    assert.equal(await deliverOne(r.id, capture(box)), "sent");
    assert.match(box[0].subject, /^Due in 1 day: Late one$/);
  });
});

// --- RB5 -----------------------------------------------------------------------------

test("RB5: a time before sending, a custom 0, or more than 5 times are refused in the form; the lone 1-day default is dropped", async (t) => {
  const MSG = /Remind before due must be less than the time between sending and due/;
  const SEND = new Date("2031-06-02T09:00:00Z");
  const err = (o: Omit<TaskOpts, "sendAt">) => parse({ sendAt: SEND, ...o }).error ?? `(accepted, saved ${JSON.stringify(parse({ sendAt: SEND, ...o }).input?.notifyBefore)})`;
  const count = async () => Number((await q("select count(*) from reminders where company_id = $1", [s.companyId]))[0].count);
  const before = await count();

  // Decided 2026-10-23: "1 day" alone is the form's default, so it's dropped, not refused.
  await t.test("the default alone before sending: due 2 hours after sending, '1 day before' is dropped", () => {
    const r = parse({ sendAt: SEND, due: new Date(SEND.getTime() + 2 * 60 * MIN), remind: ["1440"] });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.input?.notifyBefore ?? [], []);
  });
  await t.test("the default alone exactly at sending: due 1 day after sending, '1 day before' is dropped", () => {
    const r = parse({ sendAt: SEND, due: new Date(SEND.getTime() + DAY), remind: ["1440"] });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.input?.notifyBefore ?? [], []);
  });
  await t.test("a preset before sending with another time: due 2 hours after, '1 day' and '1 hour'", () => {
    assert.match(err({ due: new Date(SEND.getTime() + 2 * 60 * MIN), remind: ["1440", "60"] }), MSG);
  });
  await t.test("a custom time before sending", () => {
    assert.match(err({ due: new Date(SEND.getTime() + 2 * 60 * MIN), custom: "3", unit: "hours" }), MSG);
  });
  await t.test("a custom time of 0", () => {
    assert.match(err({ due: new Date(SEND.getTime() + 10 * DAY), custom: "0", unit: "minutes" }), /remind/i);
  });
  // The form offers 4 presets and one Custom: a sixth time needs a crafted post.
  await t.test("more than 5 times", () => {
    assert.match(err({ due: new Date(SEND.getTime() + 30 * DAY), remind: ["60", "1440", "2880", "10080", "120"], custom: "3", unit: "days" }), /remind/i);
  });
  await t.test("controls: just inside the gap, and five times, are fine; nothing refused was saved", async () => {
    assert.equal(parse({ sendAt: SEND, due: new Date(SEND.getTime() + DAY + MIN), remind: ["1440"] }).error, undefined, "a day and a minute, 1 day before");
    assert.equal(
      parse({ sendAt: SEND, due: new Date(SEND.getTime() + 30 * DAY), remind: ["60", "1440", "2880", "10080"], custom: "3", unit: "days" }).error,
      undefined,
      "five times",
    );
    assert.equal(await count(), before);
  });
});

// --- RB6 -----------------------------------------------------------------------------

test("RB6: a repeating task gets its remind-before before the due time of every date", async () => {
  const SEND = new Date("2031-07-07T09:00:00Z");
  const id = await task({ sendAt: SEND, due: new Date(SEND.getTime() + 3 * 60 * MIN), remind: ["60"], users: [alice, bob], repeat: "daily" });
  for (let d = 0; d < 3; d++) {
    const date = SEND.getTime() + d * DAY;
    if (d) await tick(new Date(date));
    await tick(new Date(date + 119 * MIN));
    await tick(new Date(date + 120 * MIN)); // 1 hour before due
    await tick(new Date(date + 150 * MIN));
    await tick(new Date(date + 180 * MIN));
  }
  const rows = await dueOf(id);
  const byDate = new Map<number, string[]>();
  for (const r of rows) byDate.set(new Date(r.occurs_at).getTime(), [...(byDate.get(new Date(r.occurs_at).getTime()) ?? []), name(r.user_id)]);
  assert.equal(byDate.size, 3, `three dates: ${JSON.stringify([...byDate.keys()].map((x) => new Date(x).toISOString()))}`);
  for (const [at, who] of byDate) assert.deepEqual(who.sort(), ["alice", "bob"], `each assignee once on ${new Date(at).toISOString()}`);
  assert.ok(rows.every((r) => r.before_minutes === 60));

  // Done on one date doesn't carry to the next.
  const SEND2 = new Date("2031-07-14T09:00:00Z");
  const id2 = await task({ sendAt: SEND2, due: new Date(SEND2.getTime() + 3 * 60 * MIN), remind: ["60"], users: [alice], repeat: "daily" });
  await tick(SEND2);
  assert.equal(await setDone(alice, s.companyId, await assignment(id2, alice, SEND2), true), null);
  await tick(new Date(SEND2.getTime() + 120 * MIN));
  await tick(new Date(SEND2.getTime() + DAY));
  await tick(new Date(SEND2.getTime() + DAY + 120 * MIN));
  const got = await deliverAll(await dueOf(id2));
  const sentDates = (await dueOf(id2)).filter((r) => r.status === "sent").map((r) => new Date(r.occurs_at).getTime());
  assert.equal(sentDates.length, 1, `only the second date (alice was done with the first): ${JSON.stringify(got)}`);
  assert.ok(sentDates[0] > SEND2.getTime() + 3 * 60 * MIN, "the one sent is the second date's");
});

// --- RB7 -----------------------------------------------------------------------------

test("RB7: editing a repeating task (this one / following / all) carries the remind-before list over unless changed", async (t) => {
  const SEND = new Date("2031-08-04T09:00:00Z"); // a Monday
  const DUE = new Date(SEND.getTime() + 2 * DAY);
  const mk = () => task({ title: "Weekly check", sendAt: SEND, due: DUE, remind: ["1440", "60"], custom: "90", unit: "minutes", users: [alice], repeat: "weekly" });
  const week = (n: number) => new Date(SEND.getTime() + n * 7 * DAY);

  await t.test("this one (moved, or edited through the form)", async () => {
    const id = await mk();
    const moved = await moveEntry(await actor(), s.companyId, id, week(1), new Date(week(1).getTime() + 60 * MIN), "one");
    assert.ok("id" in moved, JSON.stringify(moved));
    assert.deepEqual(await savedBefore(moved.id), [60, 90, 1440], "the moved date keeps the list");
    assert.deepEqual(await savedBefore(id), [60, 90, 1440], "the series keeps it");
  });

  await t.test("this and following", async () => {
    const id = await mk();
    const split = await moveEntry(await actor(), s.companyId, id, week(2), week(2), "following");
    assert.ok("id" in split, JSON.stringify(split));
    assert.notEqual(split.id, id);
    assert.deepEqual(await savedBefore(split.id), [60, 90, 1440], "the new part keeps the list");
    assert.deepEqual(await savedBefore(id), [60, 90, 1440], "the earlier part keeps it");
    // And the new part still reminds before its first date.
    await tick(week(2));
    await tick(new Date(week(2).getTime() + 2 * DAY - 1440 * MIN));
    assert.deepEqual(summary(await dueOf(split.id)), ["alice:email:1440"]);
  });

  await t.test("all (moved), and an edit through the form", async () => {
    const id = await mk();
    const moved = await moveEntry(await actor(), s.companyId, id, SEND, new Date(SEND.getTime() + 60 * MIN), "all");
    assert.ok("id" in moved, JSON.stringify(moved));
    assert.deepEqual(await savedBefore(id), [60, 90, 1440], "moving the whole series keeps it");

    // An edit of everything else posts the list as the form pre-fills it: kept.
    const same = parse({ title: "Weekly check (renamed)", sendAt: SEND, due: DUE, remind: ["1440", "60"], custom: "90", unit: "minutes", users: [alice], repeat: "weekly" });
    assert.equal(same.error, undefined);
    assert.equal(await updateReminder(await actor(), s.companyId, id, same.input!), null);
    assert.deepEqual(await savedBefore(id), [60, 90, 1440], "kept through an edit");
    // Changed: the new list.
    const changed = parse({ title: "Weekly check (renamed)", sendAt: SEND, due: DUE, remind: ["60"], users: [alice], repeat: "weekly" });
    assert.equal(await updateReminder(await actor(), s.companyId, id, changed.input!), null);
    assert.deepEqual(await savedBefore(id), [60], "changed when changed");
  });

  await t.test("the edit form pre-fills the saved times (including a custom one)", { skip: "browser: the edit form's ticked boxes and Custom field" }, () => {});
});

// --- RB8 -----------------------------------------------------------------------------

test("RB8: a task sent only to outside addresses: they get it too, until the creator marks the date done", async () => {
  const SEND = new Date("2031-09-01T09:00:00Z");
  const DUE = new Date(SEND.getTime() + 3 * DAY);
  const id = await task({ title: "Send the invoice", sendAt: SEND, due: DUE, remind: ["2880", "1440", "60"], users: [], emails: OUTSIDE });
  await tick(SEND);
  await tick(new Date(DUE.getTime() - 2880 * MIN));
  const first = await dueOf(id);
  assert.deepEqual(summary(first), ["outside:email:2880"]);
  assert.equal(first[0].address, OUTSIDE);
  assert.equal(first[0].user_id, null);
  const box: Mail[] = [];
  assert.equal(await deliverOne(first[0].id, capture(box)), "sent");
  assert.equal(box[0].to, OUTSIDE);
  assert.match(box[0].subject, /^Due in 2 days: Send the invoice$/, `the subject: ${box[0].subject}`);

  // Queued, then the creator marks the date done: not sent.
  await tick(new Date(DUE.getTime() - 1440 * MIN));
  const queued = (await dueOf(id)).filter((r) => r.before_minutes === 1440);
  assert.equal(queued.length, 1);
  const [occ] = await q("select id from reminder_occurrences where reminder_id = $1", [id]);
  assert.equal(await setOccurrenceDone(await actor(), s.companyId, occ.id, true), null);
  const got = await deliverAll(queued);
  assert.doesNotMatch(got["outside:email:1440"], /^sent|, [1-9]/, `marked done: not sent (${JSON.stringify(got)})`);

  // And nothing more after that.
  await tick(new Date(DUE.getTime() - 60 * MIN));
  const later = (await dueOf(id)).filter((r) => r.before_minutes === 60);
  const after = await deliverAll(later);
  assert.ok(Object.values(after).every((v) => !/^sent|, [1-9]/.test(v)), `nothing after it's done: ${JSON.stringify(after)}`);
});

// --- RB9 -----------------------------------------------------------------------------

test("RB9: can't be muted in Preferences, like the task itself", async () => {
  assert.ok(
    MUTABLE.every((m) => !/due/i.test(`${m.event} ${m.label}`)),
    `no "due soon" entry among the mutable events: ${MUTABLE.map((m) => m.event).join(", ")}`,
  );

  // Alice turns off everything Preferences offers; she still gets it everywhere.
  await setMutes(s.companyId, alice, MUTABLE.flatMap((m) => m.channels.map((c) => `${m.event}:${c}`)));
  const SEND = new Date("2031-10-06T09:00:00Z");
  const DUE = new Date(SEND.getTime() + 2 * DAY);
  const id = await task({ title: "Muted?", sendAt: SEND, due: DUE, remind: ["1440"], users: [alice], channels: ["email", "slack"] });
  await tick(SEND);
  await tick(new Date(DUE.getTime() - 1440 * MIN));
  const rows = await dueOf(id);
  assert.deepEqual(summary(rows), ["alice:email:1440", "alice:slack:1440"]);
  const got = await deliverAll(rows);
  assert.deepEqual(got, { "alice:email:1440": "sent, 1 message(s)", "alice:slack:1440": "sent, 1 message(s)" });
  const notes = await q("select text from notifications where user_id = $1 and reminder_id = $2", [alice, id]);
  assert.ok(notes.some((n) => /due in 1 day/i.test(n.text)), `in the app too: ${JSON.stringify(notes.map((n) => n.text))}`);
  await setMutes(s.companyId, alice, []);
});
