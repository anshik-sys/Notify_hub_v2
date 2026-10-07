import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db, withTenant } from "@/db";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import {
  cancelReminder,
  createReminder,
  decideReminder,
  getReminder,
  isDelayed,
  pauseReminder,
  resumeReminder,
  skipNextOccurrence,
  outOfScope,
  reminderAccess,
  type RawReminder,
  type Target,
  updateReminder,
  validateInput,
} from "./reminders";
import { resolveRecipients } from "./recipients";
import { seeder } from "./test-helpers";
import { toLocalInput } from "./time";

const s = seeder();
const other = seeder();
let admin: string, alice: string, bob: string, carol: string, gone: string, stranger: string;
let ops: string, sales: string;

const raw = (over: Partial<RawReminder> = {}): RawReminder => ({
  title: "Standup",
  description: "",
  senderName: "",
  linkLabels: [],
  linkUrls: [],
  company: false,
  departmentIds: [],
  userIds: [],
  emails: "",
  when: "now",
  sendAtLocal: "",
  repeat: { repeat: "none", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" },
  ...over,
});
const oneTime = { recurrence: null, anchorLocal: "2026-01-01T00:00", timeZone: "UTC" };
// An hour ahead: a worker running on this machine must not send test reminders
// mid-test (it would, within a second, for anything due now).
const later = () => new Date(Date.now() + 3_600_000);
const actor = async (id: string) => ({ id, access: await loadAccess(s.companyId, id) });
const dept = async (name: string, members: [string, boolean][]) => {
  const { rows } = await s.owner.query("insert into departments (company_id, name) values ($1, $2) returning id", [s.companyId, name]);
  for (const [u, mgr] of members)
    await s.owner.query("insert into department_members values ($1, $2, $3, $4)", [s.companyId, rows[0].id, u, mgr]);
  return rows[0].id as string;
};

before(async () => {
  await s.company();
  await other.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [alice, bob, carol, gone] = [await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user(), await s.user(), await s.user()];
  await s.owner.query(`update "user" set deactivated_at = now() where id = $1`, [gone]);
  stranger = await other.user();
  ops = await dept("Ops", [
    [alice, false],
    [bob, true],
    [gone, false],
  ]);
  sales = await dept("Sales", [[carol, false]]);
});
after(async () => {
  await s.cleanup();
  await other.cleanup();
  await db.$client.end();
});

test("validateInput", () => {
  const ok = validateInput(raw({ departmentIds: ["d"], linkUrls: ["https://x.test/a"], linkLabels: [""] }), "UTC", "Alerts | Co").input!;
  assert.deepEqual(ok.links, [{ label: "x.test", url: "https://x.test/a" }]);
  assert.equal(ok.senderName, "Alerts | Co");

  const err = (r: Partial<RawReminder>) => (validateInput(raw({ userIds: ["u"], ...r }), "UTC", "A") as { error: string }).error;
  assert.match(err({ title: " " }), /Title/);
  assert.match(err({ linkUrls: ["javascript:alert(1)"] }), /http/);
  assert.match(err({ linkUrls: Array(11).fill("https://x.test") }), /At most 10/);
  assert.match(err({ emails: "a@b.test, nope" }), /"nope"/);
  assert.match((validateInput(raw(), "UTC", "A") as { error: string }).error, /at least one/);
  assert.match(err({ when: "later", sendAtLocal: "2000-01-01T00:00" }), /future/);

  const company = validateInput(raw({ company: true, departmentIds: ["d"], emails: "X@Y.test" }), "UTC", "A").input!;
  assert.deepEqual(company.targets, [
    { kind: "company", ref: null },
    { kind: "email", ref: "x@y.test" },
  ]);
});

const resolve = (targets: Target[]) => withTenant(s.companyId, (tx) => resolveRecipients(tx, s.companyId, targets));

test("resolveRecipients: dedupe, active only, own company, typed internal email", async () => {
  const aliceEmail = `${alice}@${s.domain}`;
  const r = await resolve([
    { kind: "department", ref: ops },
    { kind: "user", ref: alice },
    { kind: "user", ref: stranger },
    { kind: "email", ref: aliceEmail },
    { kind: "email", ref: "ext@else.test" },
  ]);
  assert.deepEqual(r.users.map((u) => u.id).sort(), [alice, bob].sort()); // gone excluded, stranger invisible
  assert.deepEqual(r.external, ["ext@else.test"]);
  const all = await resolve([{ kind: "company", ref: null }]);
  assert.deepEqual(all.users.map((u) => u.id).sort(), [admin, alice, bob, carol].sort());
});

test("outOfScope (PRD 5.2)", async () => {
  const check = async (who: string, targets: Target[]) =>
    withTenant(s.companyId, async (tx) =>
      outOfScope(tx, s.companyId, await actor(who), targets, await resolveRecipients(tx, s.companyId, targets)),
    );
  assert.deepEqual(await check(admin, [{ kind: "company", ref: null }]), []);
  assert.deepEqual(await check(alice, [{ kind: "department", ref: ops }]), []);
  assert.deepEqual(await check(alice, [{ kind: "user", ref: bob }]), []); // own manager
  assert.deepEqual(await check(alice, [{ kind: "department", ref: sales }]), ["the Sales department", `${carol}@${s.domain}`]);
  assert.deepEqual(await check(alice, [{ kind: "company", ref: null }]).then((r) => r[0]), "the whole company");
  assert.deepEqual(await check(alice, [{ kind: "email", ref: "ext@else.test" }]), ["ext@else.test (outside the company)"]);
  assert.deepEqual(await check(carol, [{ kind: "user", ref: alice }]), [`${alice}@${s.domain}`]);
  // In no department: only yourself is in scope.
  const loner = await s.user({ roles: [MEMBER_ROLE_ID] });
  assert.deepEqual(await check(loner, [{ kind: "user", ref: loner }]), []);
  assert.deepEqual(await check(loner, [{ kind: "user", ref: alice }]), [`${alice}@${s.domain}`]);
});

test("lifecycle: create, approve, reject, edit, widen, cancel", async () => {
  const input = (targets: Target[]) => ({ title: "T", description: "", links: [], senderName: "S", sendAt: later(), ...oneTime, targets });

  const own = await createReminder(await actor(alice), s.companyId, input([{ kind: "department", ref: ops }]));
  assert.ok("id" in own);
  assert.equal((await getReminder(s.companyId, own.id))!.status, "scheduled");

  const wide = await createReminder(await actor(alice), s.companyId, input([{ kind: "department", ref: sales }]));
  assert.ok("id" in wide);
  const pending = (await getReminder(s.companyId, wide.id))!;
  assert.equal(pending.status, "pending_approval");
  assert.ok(pending.outOfScope.includes("the Sales department"));
  assert.match(pending.shortId, /^R-[0-9A-Z]{6}$/);

  assert.match((await decideReminder(await actor(admin), s.companyId, wide.id, false))!, /reason/);
  assert.equal(await decideReminder(await actor(admin), s.companyId, wide.id, false, "Not for Sales"), null);
  const rejected = (await getReminder(s.companyId, wide.id))!;
  assert.deepEqual([rejected.status, rejected.rejectionReason, rejected.decidedBy], ["rejected", "Not for Sales", admin]);

  // Resubmit (still out of scope) -> pending; approve -> scheduled.
  assert.equal(await updateReminder(await actor(alice), s.companyId, wide.id, input([{ kind: "department", ref: sales }])), null);
  assert.equal((await getReminder(s.companyId, wide.id))!.status, "pending_approval");
  assert.equal(await decideReminder(await actor(admin), s.companyId, wide.id, true), null);
  assert.equal((await getReminder(s.companyId, wide.id))!.status, "scheduled");

  // Editing an approved reminder without new targets keeps the approval...
  assert.equal(await updateReminder(await actor(alice), s.companyId, wide.id, input([{ kind: "department", ref: sales }])), null);
  assert.equal((await getReminder(s.companyId, wide.id))!.status, "scheduled");
  // ...adding an out-of-scope target needs approval again.
  const widened = input([
    { kind: "department", ref: sales },
    { kind: "email", ref: "ext@else.test" },
  ]);
  assert.equal(await updateReminder(await actor(alice), s.companyId, wide.id, widened), null);
  assert.equal((await getReminder(s.companyId, wide.id))!.status, "pending_approval");

  // Someone else (no reminders.edit) can't edit or cancel; deciding twice fails.
  assert.match((await updateReminder(await actor(carol), s.companyId, own.id, input([{ kind: "user", ref: carol }])))!, /not found/);
  assert.match((await cancelReminder(await actor(carol), s.companyId, own.id))!, /not found/);
  assert.equal(await cancelReminder(await actor(alice), s.companyId, own.id), null);
  assert.match((await updateReminder(await actor(alice), s.companyId, own.id, input([{ kind: "user", ref: bob }])))!, /no longer/);
  assert.match((await decideReminder(await actor(admin), s.companyId, own.id, true))!, /isn't waiting/);
});

test("reminderAccess: owners full, recipients via delivery row, others none", async () => {
  const r = await createReminder(await actor(alice), s.companyId, {
    title: "Seen by",
    description: "",
    links: [],
    senderName: "S",
    sendAt: later(),
    ...oneTime,
    targets: [{ kind: "department", ref: ops }],
  });
  assert.ok("id" in r);
  const ref = { id: r.id, createdBy: alice };
  const viewer = async (id: string) => ({ ...(await actor(id)), email: `${id}@${s.domain}` });
  assert.equal(await reminderAccess(s.companyId, await viewer(alice), ref), "full");
  assert.equal(await reminderAccess(s.companyId, await viewer(bob), ref), "full"); // alice's manager
  assert.equal(await reminderAccess(s.companyId, await viewer(carol), ref), null);
  const occ = await s.owner.query(
    "insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now(), 'sent') returning id",
    [s.companyId, r.id],
  );
  await s.owner.query("insert into deliveries (company_id, reminder_id, occurrence_id, email, user_id) values ($1, $2, $3, $4, $5)", [
    s.companyId,
    r.id,
    occ.rows[0].id,
    `${carol}@${s.domain}`,
    carol,
  ]);
  assert.equal(await reminderAccess(s.companyId, await viewer(carol), ref), "recipient");
});

test("isDelayed", () => {
  const now = new Date("2026-10-07T10:00:00Z");
  const at = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000);
  const r = (status: "scheduled" | "sending" | "sent" | "pending_approval", sendAgo: number, updAgo = 0) => ({
    status,
    sendAt: at(sendAgo),
    updatedAt: at(updAgo),
  });
  assert.equal(isDelayed(r("scheduled", 30), now), false); // just due: the worker has a minute
  assert.equal(isDelayed(r("scheduled", -3600), now), false); // future
  assert.equal(isDelayed(r("scheduled", 90), now), true);
  assert.equal(isDelayed(r("sending", 600, 60), now), false);
  assert.equal(isDelayed(r("sending", 600, 180), now), true);
  assert.equal(isDelayed(r("sent", 3600, 3600), now), false);
  assert.equal(isDelayed(r("pending_approval", 3600), now), false); // waiting on a person, not the worker
});

test("recurring: first occurrence, pause/resume/skip, edit restarts the anchor", async () => {
  const tz = "Asia/Kolkata";
  // Tomorrow 09:00 local, every weekday.
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", { timeZone: tz });
  const weekdays = { repeat: "weekdays", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" };
  const parsed = validateInput(
    raw({ departmentIds: [ops], when: "later", sendAtLocal: `${tomorrow}T09:00`, repeat: weekdays }),
    tz,
    "A",
  );
  const input = parsed.input!;
  assert.deepEqual(input.recurrence?.weekdays, [0, 1, 2, 3, 4]);
  // First occurrence: tomorrow 09:00 if that's a weekday, else the next Monday.
  const firstLocal = toLocalInput(input.sendAt, tz);
  assert.ok(firstLocal >= `${tomorrow}T09:00` && firstLocal.endsWith("T09:00"));
  assert.ok(new Date(`${firstLocal.slice(0, 10)}T00:00Z`).getUTCDay() % 6 !== 0); // not Sat/Sun

  const created = await createReminder(await actor(alice), s.companyId, input);
  assert.ok("id" in created);
  const me = await actor(alice);
  const get = async () => (await getReminder(s.companyId, created.id))!;

  assert.equal(await pauseReminder(me, s.companyId, created.id), null);
  const paused = await get();
  assert.equal(paused.status, "paused");
  assert.equal(isDelayed({ ...paused, sendAt: new Date(0) }), false); // paused is never "delayed"
  assert.match((await pauseReminder(me, s.companyId, created.id))!, /Only a scheduled/);

  assert.equal(await resumeReminder(me, s.companyId, created.id), null);
  const resumed = await get();
  assert.equal(resumed.status, "scheduled");
  assert.equal(resumed.sendAt.toISOString(), input.sendAt.toISOString()); // next from now = the same first one

  assert.equal(await skipNextOccurrence(me, s.companyId, created.id), null);
  const skipped = await get();
  assert.ok(skipped.sendAt > input.sendAt);
  const occ = await s.owner.query("select occurs_at, status from reminder_occurrences where reminder_id = $1", [created.id]);
  assert.deepEqual(
    occ.rows.map((o) => [o.occurs_at.toISOString(), o.status]),
    [[input.sendAt.toISOString(), "skipped"]],
  );

  // Skip the next one while paused, then resume: "next" steps over the skipped one.
  const beforeSkip = (await get()).sendAt;
  assert.equal(await pauseReminder(me, s.companyId, created.id), null);
  await s.owner.query("update reminders set send_at = $2 where id = $1", [created.id, input.sendAt]); // back to the first
  assert.equal(await skipNextOccurrence(me, s.companyId, created.id), null); // already skipped: no-op record, advances
  assert.equal(await resumeReminder(me, s.companyId, created.id), null);
  assert.ok((await get()).sendAt.getTime() >= beforeSkip.getTime());
  assert.notEqual((await get()).sendAt.toISOString(), input.sendAt.toISOString());

  // Someone else can't control the series.
  assert.match((await pauseReminder(await actor(carol), s.companyId, created.id))!, /not found/);

  // A series edit restarts from the new start (the day after tomorrow, 10:00, daily).
  const later2 = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString("en-CA", { timeZone: tz });
  const edited = validateInput(
    raw({ departmentIds: [ops], when: "later", sendAtLocal: `${later2}T10:00`, repeat: { ...weekdays, repeat: "daily" } }),
    tz,
    "A",
  ).input!;
  assert.equal(await updateReminder(me, s.companyId, created.id, edited), null);
  const after = await get();
  assert.deepEqual([after.anchorLocal, toLocalInput(after.sendAt, tz), after.recurrence?.freq], [`${later2}T10:00`, `${later2}T10:00`, "daily"]);

  // One-time reminders can't be paused.
  const once = await createReminder(me, s.companyId, {
    title: "Once",
    description: "",
    links: [],
    senderName: "S",
    sendAt: later(),
    ...oneTime,
    targets: [{ kind: "department", ref: ops }],
  });
  assert.ok("id" in once);
  assert.match((await pauseReminder(me, s.companyId, once.id))!, /Only repeating/);
});

test("editing a series without touching its start keeps the anchor (no drift)", async () => {
  const me = await actor(alice);
  const monthly = { repeat: "monthly", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" };
  const input = validateInput(raw({ departmentIds: [ops], when: "later", sendAtLocal: "2031-01-31T09:00", repeat: monthly }), "UTC", "A").input!;
  const created = await createReminder(me, s.companyId, input);
  assert.ok("id" in created);
  // Pretend Jan and Feb went out: the next occurrence is 31 Mar... use April's 30th to show the fallback.
  await s.owner.query("update reminders set send_at = '2031-04-30T09:00Z' where id = $1", [created.id]);
  // The edit form shows 2031-04-30T09:00 as the start; the user only changes the title.
  const edit = validateInput(
    raw({ title: "Renamed", departmentIds: [ops], when: "later", sendAtLocal: "2031-04-30T09:00", repeat: monthly }),
    "UTC",
    "A",
  ).input!;
  assert.equal(await updateReminder(me, s.companyId, created.id, edit), null);
  const r = (await getReminder(s.companyId, created.id))!;
  assert.deepEqual([r.title, r.anchorLocal, r.sendAt.toISOString()], ["Renamed", "2031-01-31T09:00", "2031-04-30T09:00:00.000Z"]);
});
