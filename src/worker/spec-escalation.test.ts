// Behaviour tests from docs/expected-behaviour.md, sections 5 (E1–E13,
// overdue escalation) and 6 (SD1–SD6, one "done" when nobody is assigned).
// Written from the spec, not the code: a failure means one of them is wrong.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { companySettings, setEscalateAfterDays } from "@/lib/company";
import type { sendMail } from "@/lib/mail";
import { listNotifications, setMutes } from "@/lib/notifications";
import { loadAccess, MEMBER_ROLE_ID } from "@/lib/permissions";
import { reminderAccess, setOccurrenceDone } from "@/lib/reminders";
import { seeder } from "@/lib/test-helpers";
import { parseFilters, searchReminders } from "@/lib/views";
import { ownerDb } from "./db";
import { dispatchDue } from "./delivery";
import { escalateOverdue } from "./escalation";

const s = seeder();
const other = seeder(); // E13
const N = 3;
const DAY = 86_400_000;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

type Mail = { to: string; subject: string; text: string };
const capture = (box: Mail[]) => (async (m: Mail) => void box.push(m)) as unknown as typeof sendMail;
// Run the escalation for our company only, at `now`; returns the emails it sent.
const run = async (now: Date) => {
  const box: Mail[] = [];
  await escalateOverdue(now, s.companyId, capture(box));
  return box;
};

// Each scenario gets its own due date, a year after the previous one and far
// in the future: a live worker (real "now") never sees them as overdue, and an
// earlier scenario's task is long past the 7-day window by the next one's run.
let year = 2050;
const nextDue = () => new Date(Date.UTC(year++, 0, 15, 12));

const emailOf = (id: string) => `${id}@${s.domain}`;
const person = async (name: string, opts: { roles?: string[] } = {}) => {
  const id = await s.user({ roles: opts.roles ?? [MEMBER_ROLE_ID] });
  await q(`update "user" set name = $2 where id = $1`, [id, name]);
  return id;
};
const dept = async (members: [string, boolean][], seed = s) => {
  const { rows } = await seed.owner.query("insert into departments (company_id, name) values ($1, $2) returning id", [
    seed.companyId,
    `D-${randomUUID().slice(0, 8)}`,
  ]);
  for (const [u, mgr] of members)
    await seed.owner.query("insert into department_members values ($1, $2, $3, $4)", [seed.companyId, rows[0].id, u, mgr]);
  return rows[0].id as string;
};

// A sent one-time occurrence: a task (assignees in the company, or outside
// addresses only) or a plain reminder. Returns the reminder and occurrence ids.
async function sent(opts: {
  title: string;
  createdBy: string;
  due?: Date;
  isTask?: boolean;
  assignees?: { id: string; done?: boolean }[];
  outside?: string[];
  occStatus?: "sent" | "skipped" | "missed";
  seed?: typeof s;
}) {
  const seed = opts.seed ?? s;
  const qq = async (sql: string, params: unknown[] = []) => (await seed.owner.query(sql, params)).rows;
  const isTask = opts.isTask ?? true;
  const due = opts.due ?? new Date(Date.UTC(2049, 0, 1, 12));
  const occursAt = new Date(due.getTime() - 3_600_000);
  const [{ id: reminderId }] = await qq(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes)
     values ($1, $2, $3, $4, 'HR', $5, 'sent', 'UTC', '2049-01-01T00:00', $6, $7) returning id`,
    [seed.companyId, `R-${randomUUID().slice(0, 10)}`, opts.createdBy, opts.title, occursAt, isTask, isTask ? 60 : null],
  );
  const [{ id: occId }] = await qq(
    `insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, due_at) values ($1, $2, $3, $4, $5) returning id`,
    [seed.companyId, reminderId, occursAt, opts.occStatus ?? "sent", isTask ? due : null],
  );
  for (const a of opts.assignees ?? []) {
    await qq("insert into reminder_targets values ($1, $2, 'user', $3)", [reminderId, seed.companyId, a.id]);
    await qq(
      `insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id, status, sent_at) values ($1, $2, $3, $4, $5, 'sent', $6)`,
      [seed.companyId, reminderId, occId, `${a.id}@${seed.domain}`, a.id, occursAt],
    );
    if (isTask)
      await qq(`insert into task_assignments (company_id, reminder_id, occurrence_id, user_id, done_at) values ($1, $2, $3, $4, $5)`, [
        seed.companyId,
        reminderId,
        occId,
        a.id,
        a.done ? occursAt : null,
      ]);
  }
  for (const addr of opts.outside ?? []) {
    await qq("insert into reminder_targets values ($1, $2, 'email', $3)", [reminderId, seed.companyId, addr]);
    await qq(
      `insert into deliveries (company_id, reminder_id, occurrence_id, address, status, sent_at) values ($1, $2, $3, $4, 'sent', $5)`,
      [seed.companyId, reminderId, occId, addr, occursAt],
    );
  }
  return { reminderId: reminderId as string, occId: occId as string };
}

// Who got an "escalated" notification about this reminder (sorted, with repeats).
const told = async (reminderId: string, seed = s) =>
  (
    await seed.owner.query("select user_id from notifications where reminder_id = $1 and kind = 'escalated' order by user_id", [
      reminderId,
    ])
  ).rows.map((r) => r.user_id as string);
// Emails about this task (its title in the subject or body), as recipient addresses.
const mailsAbout = (box: Mail[], title: string) =>
  box
    .filter((m) => `${m.subject}\n${m.text}`.includes(title))
    .map((m) => m.to)
    .sort();
const sorted = (...xs: string[]) => [...xs].sort();
const setN = (n: number | null) => q("update companies set escalate_after_days = $2 where id = $1", [s.companyId, n]);
const actor = async (id: string) => ({ id, access: await loadAccess(s.companyId, id) });
const doneAt = async (occId: string) => (await q("select done_at from reminder_occurrences where id = $1", [occId]))[0].done_at as Date | null;

let creator: string;

before(async () => {
  await s.company();
  await other.company();
  creator = await person("Cora Creator");
  await setN(N);
});
after(async () => {
  await q("update companies set suspended_at = null where id = $1", [s.companyId]);
  await s.cleanup();
  await other.cleanup();
  await db.$client.end();
  await ownerDb.$client.end();
});

// --- 5. Overdue escalation ---------------------------------------------------

test("E1: setting accepts blank (off), 1 and 60; refuses 0, 61, 2.5, abc and keeps the value", async () => {
  const value = async () => (await companySettings(s.companyId)).escalateAfterDays;
  assert.equal(await setEscalateAfterDays(s.companyId, "1"), null);
  assert.equal(await value(), 1);
  assert.equal(await setEscalateAfterDays(s.companyId, "60"), null);
  assert.equal(await value(), 60);
  for (const bad of ["0", "61", "2.5", "abc"]) {
    const err = await setEscalateAfterDays(s.companyId, bad);
    assert.equal(typeof err, "string", `"${bad}" should be refused`);
    assert.ok(err, `"${bad}" should be refused with a message`);
    assert.equal(await value(), 60, `"${bad}" must leave the value unchanged`);
  }
  assert.equal(await setEscalateAfterDays(s.companyId, ""), null);
  assert.equal(await value(), null, "blank turns escalation off");
  await setN(N);
});

test("E2: each active manager of the assignee's department gets 1 notification and 1 email naming the person and task", async () => {
  const due = nextDue();
  const alice = await person("Alice Latecomer");
  const [m1, m2, colleague] = [await person("Max Manager"), await person("Mia Manager"), await person("Carl Colleague")];
  await dept([
    [alice, false],
    [m1, true],
    [m2, true],
    [colleague, false],
  ]);
  const title = "E2 quarterly report";
  const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: alice }] });

  const box = await run(new Date(due.getTime() + N * DAY));
  assert.deepEqual(await told(reminderId), sorted(m1, m2), "exactly the two managers, once each");
  assert.deepEqual(mailsAbout(box, title), sorted(emailOf(m1), emailOf(m2)), "one email to each manager");
  for (const m of box.filter((x) => x.subject.includes(title) || x.text.includes(title)))
    assert.match(`${m.subject}\n${m.text}`, /Alice Latecomer/, "email names the person");
  // What the manager sees in their notification list: the text plus the task it links to.
  for (const m of [m1, m2]) {
    const items = (await listNotifications(s.companyId, m)).items.filter((i) => i.kind === "escalated" && i.reminderId === reminderId);
    assert.equal(items.length, 1);
    assert.match(items[0].text, /Alice Latecomer/, "notification names the person");
    assert.equal(items[0].reminderTitle, title, "notification names (links to) the task");
  }
});

test("E3: assignee in two departments with different managers: both managers told", async (t) => {
  const due = nextDue();
  const bea = await person("Bea Twodepts");
  const [mA, mB] = [await person("Ann Sales Mgr"), await person("Ben Ops Mgr")];
  await dept([
    [bea, false],
    [mA, true],
  ]);
  await dept([
    [bea, false],
    [mB, true],
  ]);
  const title = "E3 inventory count";
  const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: bea }] });
  const box = await run(new Date(due.getTime() + N * DAY));
  assert.deepEqual(await told(reminderId), sorted(mA, mB));
  assert.deepEqual(mailsAbout(box, title), sorted(emailOf(mA), emailOf(mB)));

  await t.test("E3 (also): a manager of both departments is told once, not twice", async () => {
    const due2 = nextDue();
    const cy = await person("Cy Twodepts");
    const both = await person("Bo Both Mgr");
    await dept([
      [cy, false],
      [both, true],
    ]);
    await dept([
      [cy, false],
      [both, true],
    ]);
    const title2 = "E3b stock take";
    const r = await sent({ title: title2, createdBy: creator, due: due2, assignees: [{ id: cy }] });
    const box2 = await run(new Date(due2.getTime() + N * DAY));
    assert.deepEqual(await told(r.reminderId), [both]);
    assert.deepEqual(mailsAbout(box2, title2), [emailOf(both)]);
  });
});

test("E4: an assignee who is a manager isn't told about themselves; if they're the only manager, the creator is", async (t) => {
  await t.test("another manager in the department: only they are told", async () => {
    const due = nextDue();
    const selfMgr = await person("Sam Selfmanager");
    const peer = await person("Pat Peer Mgr");
    await dept([
      [selfMgr, true],
      [peer, true],
    ]);
    const title = "E4a budget sign-off";
    const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: selfMgr }] });
    const box = await run(new Date(due.getTime() + N * DAY));
    assert.deepEqual(await told(reminderId), [peer]);
    assert.deepEqual(mailsAbout(box, title), [emailOf(peer)]);
  });
  await t.test("the only manager: the creator is told", async () => {
    const due = nextDue();
    const solo = await person("Sol Onlymanager");
    const report = await person("Ray Report");
    await dept([
      [solo, true],
      [report, false],
    ]);
    const title = "E4b vendor review";
    const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: solo }] });
    const box = await run(new Date(due.getTime() + N * DAY));
    assert.deepEqual(await told(reminderId), [creator]);
    assert.deepEqual(mailsAbout(box, title), [emailOf(creator)]);
  });
});

test("E5: assignee in no department: the creator is told; if the creator is the assignee, nobody is", async (t) => {
  await t.test("creator told", async () => {
    const due = nextDue();
    const loner = await person("Lou Nodept");
    const title = "E5a expense claims";
    const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: loner }] });
    const box = await run(new Date(due.getTime() + N * DAY));
    assert.deepEqual(await told(reminderId), [creator]);
    assert.deepEqual(mailsAbout(box, title), [emailOf(creator)]);
  });
  await t.test("creator is the assignee: nobody told", async () => {
    const due = nextDue();
    const selfie = await person("Sid Selfassigned");
    const title = "E5b own todo";
    const { reminderId } = await sent({ title, createdBy: selfie, due, assignees: [{ id: selfie }] });
    const box = await run(new Date(due.getTime() + N * DAY));
    assert.deepEqual(await told(reminderId), []);
    assert.deepEqual(mailsAbout(box, title), []);
  });
});

test("E6: assignee already done: nobody told", async () => {
  const due = nextDue();
  const done = await person("Dee Done");
  const mgr = await person("Mo Mgr E6");
  await dept([
    [done, false],
    [mgr, true],
  ]);
  const title = "E6 finished thing";
  const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: done, done: true }] });
  const box = await run(new Date(due.getTime() + N * DAY));
  assert.deepEqual(await told(reminderId), []);
  assert.deepEqual(mailsAbout(box, title), []);
});

test("E7: N-1 days past due: not yet; exactly N days: told", async () => {
  const due = nextDue();
  const slow = await person("Sly Slow");
  const mgr = await person("Meg Mgr E7");
  await dept([
    [slow, false],
    [mgr, true],
  ]);
  const title = "E7 timesheet";
  const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: slow }] });
  const early = await run(new Date(due.getTime() + (N - 1) * DAY));
  assert.deepEqual(await told(reminderId), [], "not escalated at N-1 days");
  assert.deepEqual(mailsAbout(early, title), []);
  const onTime = await run(new Date(due.getTime() + N * DAY));
  assert.deepEqual(await told(reminderId), [mgr], "escalated at exactly N days");
  assert.deepEqual(mailsAbout(onTime, title), [emailOf(mgr)]);
});

test("E8: the worker runs again: not told again", async () => {
  const due = nextDue();
  const late = await person("Lee Late E8");
  const mgr = await person("Mac Mgr E8");
  await dept([
    [late, false],
    [mgr, true],
  ]);
  const title = "E8 safety training";
  const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: late }] });
  const at = due.getTime() + N * DAY;
  const first = await run(new Date(at));
  assert.deepEqual(await told(reminderId), [mgr]);
  assert.deepEqual(mailsAbout(first, title), [emailOf(mgr)]);
  for (const later of [at + 60_000, at + DAY, at + 3 * DAY]) {
    const again = await run(new Date(later));
    assert.deepEqual(mailsAbout(again, title), [], "no second email");
  }
  assert.deepEqual(await told(reminderId), [mgr], "still one notification");
});

test("E9: no escalation when off, suspended, cancelled, deleted, or the assignee is deactivated; a deactivated manager isn't told", async (t) => {
  // An overdue task whose assignee has an active manager; returns what the run did.
  const scenario = async (label: string, prepare: (r: { reminderId: string; assignee: string; mgr: string }) => Promise<unknown>) => {
    const due = nextDue();
    const assignee = await person(`Ann ${label}`);
    const mgr = await person(`Mgr ${label}`);
    await dept([
      [assignee, false],
      [mgr, true],
    ]);
    const title = `E9 ${label}`;
    const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: assignee }] });
    await prepare({ reminderId, assignee, mgr });
    const box = await run(new Date(due.getTime() + N * DAY));
    return { notified: await told(reminderId), mailed: mailsAbout(box, title) };
  };

  await t.test("setting off", async () => {
    try {
      const r = await scenario("off", () => setN(null));
      assert.deepEqual(r, { notified: [], mailed: [] });
    } finally {
      await setN(N);
    }
  });
  await t.test("company suspended", async () => {
    try {
      const r = await scenario("suspended", () => q("update companies set suspended_at = now() where id = $1", [s.companyId]));
      assert.deepEqual(r, { notified: [], mailed: [] });
    } finally {
      await q("update companies set suspended_at = null where id = $1", [s.companyId]);
    }
  });
  await t.test("task cancelled", async () => {
    const r = await scenario("cancelled", ({ reminderId }) => q("update reminders set status = 'cancelled' where id = $1", [reminderId]));
    assert.deepEqual(r, { notified: [], mailed: [] });
  });
  await t.test("task deleted", async () => {
    const r = await scenario("deleted", ({ reminderId }) =>
      q("update reminders set deleted_at = now(), status = 'cancelled' where id = $1", [reminderId]),
    );
    assert.deepEqual(r, { notified: [], mailed: [] });
  });
  await t.test("assignee deactivated", async () => {
    const r = await scenario("gone-assignee", ({ assignee }) => q(`update "user" set deactivated_at = now() where id = $1`, [assignee]));
    assert.deepEqual(r, { notified: [], mailed: [] });
  });
  await t.test("manager deactivated: not told, the other manager is", async () => {
    const due = nextDue();
    const assignee = await person("Ann gone-mgr");
    const [goneMgr, liveMgr] = [await person("Gus Gone Mgr"), await person("Liv Live Mgr")];
    await dept([
      [assignee, false],
      [goneMgr, true],
      [liveMgr, true],
    ]);
    await q(`update "user" set deactivated_at = now() where id = $1`, [goneMgr]);
    const title = "E9 gone-mgr";
    const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: assignee }] });
    const box = await run(new Date(due.getTime() + N * DAY));
    assert.deepEqual(await told(reminderId), [liveMgr]);
    assert.deepEqual(mailsAbout(box, title), [emailOf(liveMgr)]);
  });
});

test("E10: a manager who muted 'late on a task' by email gets the in-app notification only", async () => {
  const due = nextDue();
  const late = await person("Lia Late E10");
  const [quiet, loud] = [await person("Quinn Quiet Mgr"), await person("Lou Loud Mgr")];
  await dept([
    [late, false],
    [quiet, true],
    [loud, true],
  ]);
  await setMutes(s.companyId, quiet, ["escalated:email"]);
  const title = "E10 compliance form";
  const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: late }] });
  const box = await run(new Date(due.getTime() + N * DAY));
  assert.deepEqual(await told(reminderId), sorted(quiet, loud), "both get the in-app notification");
  assert.deepEqual(mailsAbout(box, title), [emailOf(loud)], "only the unmuted manager gets an email");
});

test("E11: after being told, the manager can open the task as a viewer and finds it in their list; before, they can't", async () => {
  const due = nextDue();
  const late = await person("Lex Late E11");
  const mgr = await person("Moe Mgr E11");
  await dept([
    [late, false],
    [mgr, true],
  ]);
  const title = "E11 audit prep";
  const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: late }] });
  const viewer = async () => ({ ...(await actor(mgr)), email: emailOf(mgr) });
  const listed = async () =>
    (await searchReminders(s.companyId, await viewer(), "UTC", parseFilters({ q: title }))).rows.map((r) => r.id);

  assert.equal(await reminderAccess(s.companyId, await viewer(), { id: reminderId, createdBy: creator }), null, "can't open before");
  assert.deepEqual(await listed(), [], "not in their list before");

  await run(new Date(due.getTime() + N * DAY));
  assert.deepEqual(await told(reminderId), [mgr]);
  assert.equal(
    await reminderAccess(s.companyId, await viewer(), { id: reminderId, createdBy: creator }),
    "viewer",
    "opens it as a viewer (sees the task, not the delivery log)",
  );
  assert.deepEqual(await listed(), [reminderId], "finds it in their reminder list");
});

test("E12: threshold crossed more than 7 days ago (setting just turned on): not escalated", async () => {
  const due = nextDue();
  const old = await person("Ola Old E12");
  const mgr = await person("Mal Mgr E12");
  await dept([
    [old, false],
    [mgr, true],
  ]);
  const title = "E12 ancient task";
  const { reminderId } = await sent({ title, createdBy: creator, due, assignees: [{ id: old }] });
  try {
    await setN(null);
    await setN(N); // "just turned on"
    const box = await run(new Date(due.getTime() + (N + 8) * DAY));
    assert.deepEqual(await told(reminderId), []);
    assert.deepEqual(mailsAbout(box, title), []);
  } finally {
    await setN(N);
  }
});

test("E13: another company's overdue tasks are untouched", async () => {
  const due = nextDue();
  await other.owner.query("update companies set escalate_after_days = $2 where id = $1", [other.companyId, N]);
  const oCreator = await other.user();
  const oLate = await other.user();
  const oMgr = await other.user();
  await dept(
    [
      [oLate, false],
      [oMgr, true],
    ],
    other,
  );
  const oTitle = "E13 other company task";
  const theirs = await sent({ title: oTitle, createdBy: oCreator, due, assignees: [{ id: oLate }], seed: other });
  // A task of ours in the same run, so we know the run did escalate something.
  const late = await person("Ned Late E13");
  const mgr = await person("Nia Mgr E13");
  await dept([
    [late, false],
    [mgr, true],
  ]);
  const title = "E13 our task";
  const ours = await sent({ title, createdBy: creator, due, assignees: [{ id: late }] });

  const box = await run(new Date(due.getTime() + N * DAY));
  assert.deepEqual(await told(ours.reminderId), [mgr], "our own task escalated");
  assert.deepEqual(await told(theirs.reminderId, other), [], "no notification in the other company");
  assert.deepEqual(mailsAbout(box, oTitle), [], "no email about the other company's task");
  const [a] = (await other.owner.query("select escalated_at from task_assignments where reminder_id = $1", [theirs.reminderId])).rows;
  assert.equal(a.escalated_at, null, "the other company's assignment isn't stamped");
});

// --- 6. One "done" when nobody is assigned -----------------------------------

test("SD1: task sent only outside: creator and an editor who can see it can Mark done / Undo; a member who can't edit is refused", async () => {
  const [{ id: editorRole }] = await q(
    "insert into roles (company_id, name, permissions) values ($1, 'SD Editor', $2) returning id",
    [s.companyId, ["reminders.edit", "reminders.view_all"]],
  );
  const editor = await person("Eddie Editor", { roles: [editorRole] });
  const member = await person("Mel Member");
  const { occId } = await sent({ title: "SD1 outside task", createdBy: creator, outside: [`vendor@outside-${s.companyId}.test`] });

  assert.equal(await setOccurrenceDone(await actor(creator), s.companyId, occId, true), null, "creator marks done");
  assert.notEqual(await doneAt(occId), null);
  assert.equal(await setOccurrenceDone(await actor(creator), s.companyId, occId, false), null, "creator undoes");
  assert.equal(await doneAt(occId), null);

  assert.equal(await setOccurrenceDone(await actor(editor), s.companyId, occId, true), null, "editor marks done");
  assert.notEqual(await doneAt(occId), null);
  assert.equal(await setOccurrenceDone(await actor(editor), s.companyId, occId, false), null, "editor undoes");
  assert.equal(await doneAt(occId), null);

  const err = await setOccurrenceDone(await actor(member), s.companyId, occId, true);
  assert.equal(typeof err, "string", "member is refused");
  assert.equal(await doneAt(occId), null, "nothing changes");
});

test("SD2: plain reminder (not a task), sent: creator can Mark complete / Undo", async () => {
  const colleague = await person("Col Recipient SD2");
  const { occId } = await sent({ title: "SD2 announcement", createdBy: creator, isTask: false, assignees: [{ id: colleague }] });
  assert.equal(await setOccurrenceDone(await actor(creator), s.companyId, occId, true), null);
  assert.notEqual(await doneAt(occId), null);
  assert.equal(await setOccurrenceDone(await actor(creator), s.companyId, occId, false), null);
  assert.equal(await doneAt(occId), null);
});

test("SD3: task with assignees in the company: refused (each assignee marks it themselves)", async () => {
  const assignee = await person("Asa Assignee SD3");
  const { occId } = await sent({ title: "SD3 assigned task", createdBy: creator, assignees: [{ id: assignee }] });
  const err = await setOccurrenceDone(await actor(creator), s.companyId, occId, true);
  assert.equal(typeof err, "string", "refused");
  assert.equal(await doneAt(occId), null, "nothing changes");
});

test("SD4: occurrence not sent (skipped, missed): refused", async () => {
  for (const status of ["skipped", "missed"] as const) {
    const { occId } = await sent({
      title: `SD4 ${status}`,
      createdBy: creator,
      isTask: false,
      outside: [`x-${status}@outside-${s.companyId}.test`],
      occStatus: status,
    });
    const err = await setOccurrenceDone(await actor(creator), s.companyId, occId, true);
    assert.equal(typeof err, "string", `${status}: refused`);
    assert.equal(await doneAt(occId), null, `${status}: nothing changes`);
  }
});

test("SD5: repeating: the next occurrence starts not done", async () => {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, recurrence)
     values ($1, $2, $3, 'SD5 weekly note', 'HR', '2045-06-01T09:00Z', 'scheduled', 'UTC', '2045-06-01T09:00', $4) returning id`,
    [s.companyId, `R-${randomUUID().slice(0, 10)}`, creator, JSON.stringify({ freq: "daily", interval: 1, end: { type: "never" } })],
  );
  await q("insert into reminder_targets values ($1, $2, 'email', $3)", [id, s.companyId, `sd5@outside-${s.companyId}.test`]);
  const enqueue = async () => {};
  try {
    await dispatchDue(enqueue, s.companyId, new Date("2045-06-01T09:00:30Z"));
    const [first] = await q("select id from reminder_occurrences where reminder_id = $1", [id]);
    assert.ok(first, "first occurrence dispatched");
    await q("update reminder_occurrences set status = 'sent' where id = $1", [first.id]); // its sends finished
    assert.equal(await setOccurrenceDone(await actor(creator), s.companyId, first.id, true), null);

    await dispatchDue(enqueue, s.companyId, new Date("2045-06-02T09:00:30Z"));
    const occ = await q("select id, done_at from reminder_occurrences where reminder_id = $1 order by occurs_at", [id]);
    assert.equal(occ.length, 2, "second occurrence dispatched");
    assert.notEqual(occ[0].done_at, null, "the first stays done");
    assert.equal(occ[1].done_at, null, "the next starts not done");
  } finally {
    await q("update reminders set status = 'cancelled' where id = $1", [id]);
  }
});

test("SD6: the reminder was deleted: refused", async () => {
  const { reminderId, occId } = await sent({
    title: "SD6 deleted",
    createdBy: creator,
    isTask: false,
    outside: [`sd6@outside-${s.companyId}.test`],
  });
  const { occId: doneOcc, reminderId: doneReminder } = await sent({
    title: "SD6 deleted after done",
    createdBy: creator,
    isTask: false,
    outside: [`sd6b@outside-${s.companyId}.test`],
  });
  assert.equal(await setOccurrenceDone(await actor(creator), s.companyId, doneOcc, true), null);
  await q("update reminders set deleted_at = now(), status = 'cancelled' where id = any($1)", [[reminderId, doneReminder]]);

  assert.equal(typeof (await setOccurrenceDone(await actor(creator), s.companyId, occId, true)), "string", "mark done refused");
  assert.equal(await doneAt(occId), null);
  assert.equal(typeof (await setOccurrenceDone(await actor(creator), s.companyId, doneOcc, false)), "string", "undo refused");
  assert.notEqual(await doneAt(doneOcc), null);
});
