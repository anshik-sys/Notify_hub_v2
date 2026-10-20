import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db, withTenant } from "@/db";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import {
  cancelReminder,
  createReminder,
  decideReminder,
  deleteReminder,
  detachOccurrence,
  setOccurrenceDone,
  getReminder,
  isDelayed,
  listAttachments,
  pauseReminder,
  resumeReminder,
  skipNextOccurrence,
  outOfScope,
  reminderAccess,
  type RawReminder,
  type Target,
  updateReminder,
  validateInput,
  parseTags,
  type Share,
  mayDecide,
  mayChange,
  duplicateReminder,
  quickCreate,
  setMyColor,
  moveEntry,
  deleteEntry,
} from "./reminders";
import { sendNow } from "./send-now";
import { checkFile } from "./attachments";
import { encrypt } from "./crypto";
import { resolveRecipients } from "./recipients";
import { setMutes } from "./notifications";
import { seeder } from "./test-helpers";
import { parseFilters, searchReminders } from "./views";
import { toLocalInput } from "./time";
import type { Rule } from "./recurrence";

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
  groupIds: [],
  userIds: [],
  emails: "",
  when: "now",
  sendAtLocal: "",
  repeat: { repeat: "none", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" },
  isTask: false,
  dueLocal: "",
  channels: ["email"],
  slackChannelIds: [],
  tags: "",
  shareMine: false,
  shareDepartmentIds: [],
  shareGroupIds: [],
  shareCompany: false,
  ...over,
});
const oneTime = {
  recurrence: null,
  anchorLocal: "2026-01-01T00:00",
  timeZone: "UTC",
  isTask: false,
  dueAfterMinutes: null,
  channels: ["email" as const],
  tags: [] as string[],
  shares: [] as Share[],
};
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
  assert.match((validateInput(raw(), "UTC", "A") as { error: string }).error, /Email needs people/); // no recipients at all
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

test("an editor without approve can't widen an approver's reminder unchecked", async () => {
  const input = (targets: Target[]) => ({ title: "T", description: "", links: [], senderName: "S", sendAt: later(), ...oneTime, targets });
  const { rows } = await s.owner.query("insert into roles (company_id, name, permissions) values ($1, 'Editors', '{reminders.edit,reminders.view_all}') returning id", [s.companyId]);
  const editor = await s.user({ roles: [MEMBER_ROLE_ID, rows[0].id] });

  const r = await createReminder(await actor(admin), s.companyId, input([{ kind: "user", ref: alice }]));
  assert.ok("id" in r);
  assert.equal(await updateReminder(await actor(editor), s.companyId, r.id, input([{ kind: "company", ref: null }])), null);
  assert.equal((await getReminder(s.companyId, r.id))!.status, "pending_approval");

  // An approver editing a member's in-scope reminder changes nothing.
  const own = await createReminder(await actor(alice), s.companyId, input([{ kind: "department", ref: ops }]));
  assert.ok("id" in own);
  assert.equal(await updateReminder(await actor(admin), s.companyId, own.id, input([{ kind: "department", ref: ops }])), null);
  assert.equal((await getReminder(s.companyId, own.id))!.status, "scheduled");
});

test("edit, cancel and send now need the reminder to be visible, not just the permission", async () => {
  const input = (targets: Target[]) => ({ title: "T", description: "", links: [], senderName: "S", sendAt: later(), ...oneTime, targets });
  const { rows } = await s.owner.query("insert into roles (company_id, name, permissions) values ($1, 'Blind editors', '{reminders.edit,reminders.send_now}') returning id", [s.companyId]);
  const blind = await actor(await s.user({ roles: [MEMBER_ROLE_ID, rows[0].id] }));
  const r = await createReminder(await actor(carol), s.companyId, input([{ kind: "user", ref: carol }]));
  assert.ok("id" in r);

  assert.equal(await mayChange(s.companyId, blind, carol), false);
  assert.match((await updateReminder(blind, s.companyId, r.id, input([{ kind: "user", ref: carol }])))!, /not found/);
  assert.match((await cancelReminder(blind, s.companyId, r.id))!, /not found/);
  assert.match((await sendNow({ ...blind, email: "x@x.test" }, s.companyId, r.id)).error!, /not found/);
  assert.equal((await getReminder(s.companyId, r.id))!.status, "scheduled");
  // The creator and an admin still can.
  assert.equal(await mayChange(s.companyId, await actor(carol), carol), true);
  assert.equal(await mayChange(s.companyId, await actor(admin), carol), true);
});

test("getReminder lists typed addresses that unsubscribed (PRD 7.1)", async () => {
  const input = (targets: Target[]) => ({ title: "T", description: "", links: [], senderName: "S", sendAt: later(), ...oneTime, targets });
  const r = await createReminder(await actor(admin), s.companyId, input([
    { kind: "email", ref: "gone@else.test" },
    { kind: "email", ref: "here@else.test" },
    { kind: "user", ref: alice },
  ]));
  assert.ok("id" in r);
  await s.owner.query("insert into email_suppressions (company_id, email) values ($1, 'gone@else.test')", [s.companyId]);
  await other.owner.query("insert into email_suppressions (company_id, email) values ($1, 'here@else.test')", [other.companyId]);
  assert.deepEqual((await getReminder(s.companyId, r.id))!.unsubscribed, ["gone@else.test"]);
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
  await s.owner.query("insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id) values ($1, $2, $3, $4, $5)", [
    s.companyId,
    r.id,
    occ.rows[0].id,
    `${carol}@${s.domain}`,
    carol,
  ]);
  assert.equal(await reminderAccess(s.companyId, await viewer(carol), ref), "viewer");
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

test("task due: required, after the send, stored as an offset", () => {
  const now = new Date("2026-10-07T10:00:00Z");
  const task = (dueLocal: string, over: Partial<RawReminder> = {}) =>
    validateInput(raw({ userIds: ["u"], isTask: true, dueLocal, ...over }), "UTC", "A", now);
  assert.match(task("").error!, /due date/);
  assert.match(task("2026-10-07T09:00").error!, /after it's sent/);
  assert.match(task("2027-12-01T00:00").error!, /within a year/);
  assert.equal(task("2026-10-07T12:00").input!.dueAfterMinutes, 120); // sent now (10:00), due 12:00
  // Later send: the offset is from the first send, not from now.
  assert.equal(task("2026-10-09T09:00", { when: "later", sendAtLocal: "2026-10-08T09:00" }).input!.dueAfterMinutes, 24 * 60);
  // Not a task: due is ignored.
  assert.equal(validateInput(raw({ userIds: ["u"], dueLocal: "nonsense" }), "UTC", "A", now).input!.dueAfterMinutes, null);
});

test("channels (PRD 5.3)", () => {
  const slack = [
    { id: "C1", name: "general" },
    { id: "C2", name: "ops" },
  ];
  const v = (over: Partial<RawReminder>, connected: typeof slack | null = slack) =>
    validateInput(raw(over), "UTC", "A", new Date(), connected);
  assert.match(v({ userIds: ["u"], channels: [] }).error!, /at least one channel/);
  assert.match(v({ userIds: ["u"], channels: ["slack"] }, null).error!, /isn't connected/);
  assert.match(v({ company: true, channels: ["slack"] }).error!, /whole company on Slack, pick a Slack channel/);
  assert.match(v({ emails: "x@y.test", channels: ["slack"] }).error!, /Slack needs a channel, people, a department or a group/);
  assert.match(v({ channels: ["email", "slack"], slackChannelIds: ["C1"] }).error!, /Email needs people/);
  // Picks left over after unticking Slack are dropped, not refused.
  assert.deepEqual(v({ userIds: ["u"], channels: ["email"], slackChannelIds: ["C1"] }).input!.targets.map((t) => t.kind), ["user"]);
  assert.match(v({ userIds: ["u"], channels: ["slack"], slackChannelIds: ["C9"] }).error!, /no longer exists/);

  const ok = v({ company: true, channels: ["email", "slack"], slackChannelIds: ["C1", "C1"] }).input!;
  assert.deepEqual(ok.channels, ["email", "slack"]);
  assert.deepEqual(ok.targets, [
    { kind: "company", ref: null },
    { kind: "slack_channel", ref: "C1", label: "general" },
  ]);
  // Slack-only to a channel: no email recipients needed.
  assert.equal(v({ channels: ["slack"], slackChannelIds: ["C2"] }).input!.targets.length, 1);
});

test("a Slack channel counts as out of scope for non-approvers", async () => {
  const targets: Target[] = [
    { kind: "department", ref: ops },
    { kind: "slack_channel", ref: "C1", label: "general" },
  ];
  const out = await withTenant(s.companyId, async (tx) =>
    outOfScope(tx, s.companyId, await actor(alice), targets, await resolveRecipients(tx, s.companyId, targets)),
  );
  assert.deepEqual(out, ["the #general Slack channel"]);
  const asAdmin = await withTenant(s.companyId, async (tx) =>
    outOfScope(tx, s.companyId, await actor(admin), targets, await resolveRecipients(tx, s.companyId, targets)),
  );
  assert.deepEqual(asAdmin, []);
});

test("attachments: saved with the reminder, removable, capped, tenant-isolated", async () => {
  const file = (name: string, text: string) => {
    const r = checkFile(name, new TextEncoder().encode(text));
    assert.ok("file" in r);
    return r.file;
  };
  const me = await actor(alice);
  const base = { title: "With files", description: "", links: [], senderName: "S", sendAt: later(), ...oneTime, targets: [{ kind: "department" as const, ref: ops }] };
  const created = await createReminder(me, s.companyId, base, [file("a.txt", "one"), file("b.csv", "x,1\n")]);
  assert.ok("id" in created);
  const list = await listAttachments(s.companyId, created.id); // upload order, even within one save
  assert.deepEqual(list.map((f) => [f.fileName, f.contentType, f.size]), [
    ["a.txt", "text/plain; charset=utf-8", 3],
    ["b.csv", "text/csv; charset=utf-8", 4],
  ]);
  const blob = await s.owner.query("select data from attachment_blobs where attachment_id = $1", [list[0].id]);
  assert.equal(blob.rows[0].data.toString(), "one");

  // Another company sees nothing.
  assert.deepEqual(await listAttachments(other.companyId, created.id), []);

  // Edit: remove one, add one.
  assert.equal(await updateReminder(me, s.companyId, created.id, base, [file("c.txt", "three")], [list[0].id]), null);
  assert.deepEqual((await listAttachments(s.companyId, created.id)).map((f) => f.fileName), ["b.csv", "c.txt"]);
  assert.equal((await s.owner.query("select 1 from attachment_blobs where attachment_id = $1", [list[0].id])).rowCount, 0); // blob gone too

  // At most 20 per reminder; going over saves nothing.
  const many = Array.from({ length: 19 }, (_, i) => file(`f${i}.txt`, "x"));
  assert.match((await updateReminder(me, s.companyId, created.id, { ...base, title: "Too many" }, many))!, /at most 20/);
  assert.equal((await getReminder(s.companyId, created.id))!.title, "With files"); // rolled back
  assert.equal((await listAttachments(s.companyId, created.id)).length, 2);
});

test("notifications: approvers in-app (email unless muted); the creator hears the decision", async () => {
  const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
  const input = { title: "N", description: "", links: [], senderName: "S", sendAt: later(), ...oneTime, targets: [{ kind: "department" as const, ref: sales }] };
  await setMutes(s.companyId, admin, ["approval:email", "decided:email"]);
  const r = await createReminder(await actor(alice), s.companyId, input);
  assert.ok("id" in r);
  const kinds = async (userId: string) => (await q("select kind from notifications where reminder_id = $1 and user_id = $2", [r.id, userId])).map((x) => x.kind);
  assert.deepEqual(await kinds(admin), ["approval"]); // muted email, still in-app
  assert.equal(await decideReminder(await actor(admin), s.companyId, r.id, false, "No"), null);
  assert.deepEqual(await kinds(alice), ["decided"]);
  assert.match((await q("select text from notifications where reminder_id = $1 and user_id = $2", [r.id, alice]))[0].text, /Rejected: No/);
  await setMutes(s.companyId, admin, []);
});

test("notifications: approvers get a Slack DM too, unless they muted it", async () => {
  await s.owner.query(
    "insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'WS', $3, 'UBOT')",
    [s.companyId, `T-${s.companyId}`, encrypt("xoxb-test")],
  );
  const dms: string[] = [];
  const real = globalThis.fetch;
  // ponytail: createReminder takes no fetch, so stub the global one Slack calls fall back to.
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop();
    const ok = (body: object) => new Response(JSON.stringify({ ok: true, ...body }));
    if (method === "users.lookupByEmail") return ok({ user: { id: "U1" } });
    if (method === "conversations.open") return ok({ channel: { id: "D1" } });
    dms.push((init.body as URLSearchParams).get("text")!);
    return ok({ ts: "1.0" });
  }) as typeof fetch;
  try {
    const input = { title: "Slack me", description: "", links: [], senderName: "S", sendAt: later(), ...oneTime, targets: [{ kind: "department" as const, ref: sales }] };
    await setMutes(s.companyId, admin, ["approval:email"]);
    assert.ok("id" in (await createReminder(await actor(alice), s.companyId, input)));
    assert.deepEqual(dms, ['A reminder needs your approval before it can be sent: "Slack me".']);
    await setMutes(s.companyId, admin, ["approval:email", "approval:slack"]);
    assert.ok("id" in (await createReminder(await actor(alice), s.companyId, input)));
    assert.equal(dms.length, 1); // muted: no second DM
  } finally {
    globalThis.fetch = real;
    await setMutes(s.companyId, admin, []);
    await s.owner.query("delete from slack_installations where company_id = $1", [s.companyId]);
  }
});

test("tags: lowercased, de-duplicated, validated", () => {
  assert.deepEqual(parseTags(" Payroll, q3 ,payroll,,  Big   Push "), { tags: ["payroll", "q3", "big push"] });
  assert.match((parseTags("ok, <script>") as { error: string }).error, /isn't a valid tag/);
  assert.match((parseTags("x".repeat(31)) as { error: string }).error, /isn't a valid tag/);
  assert.match((parseTags(Array.from({ length: 11 }, (_, i) => `t${i}`).join(",")) as { error: string }).error, /At most 10/);
  const v = validateInput(raw({ userIds: [alice], tags: "A, b" }), "UTC", "S");
  assert.deepEqual("input" in v && v.input?.tags, ["a", "b"]);
});

test("validateInput: a group alone is a recipient for email and Slack", () => {
  const g = "11111111-1111-4111-8111-111111111111";
  const v = validateInput(raw({ groupIds: [g, g] }), "UTC", "S");
  assert.deepEqual("input" in v && v.input?.targets, [{ kind: "group", ref: g }]);
  const sl = validateInput(raw({ groupIds: [g], channels: ["slack"] }), "UTC", "S", new Date(), []);
  assert.ok("input" in sl);
});

test("sharing (PRD 5.4): departments, my departments, groups, company; foreign ids dropped", async () => {
  const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
  const viewer = async (id: string) => ({ ...(await actor(id)), email: `${id}@${s.domain}` });
  const loner = await s.user({ roles: [MEMBER_ROLE_ID] });
  const [{ id: foreignDept }] = await other.owner.query("insert into departments (company_id, name) values ($1, 'Theirs') returning id", [other.companyId]).then((r) => r.rows);
  const [{ id: night }] = await q("insert into groups (company_id, name) values ($1, 'Night shift') returning id", [s.companyId]);
  await q("insert into group_members values ($1, $2, $3)", [night, s.companyId, loner]);
  const base = { title: "Shared", description: "", links: [], senderName: "S", sendAt: later(), ...oneTime, targets: [{ kind: "user" as const, ref: alice }] };
  const access = async (id: string, who: string) => reminderAccess(s.companyId, await viewer(who), { id, createdBy: alice });
  const saved = async (id: string) => (await q("select kind, ref from reminder_shares where reminder_id = $1 order by kind, ref", [id])).map((x) => `${x.kind}:${x.ref ?? ""}`);

  const r = await createReminder(await actor(alice), s.companyId, { ...base, shares: [{ kind: "department", ref: sales }, { kind: "department", ref: foreignDept }] });
  assert.ok("id" in r);
  assert.deepEqual(await saved(r.id), [`department:${sales}`]); // the other company's department is dropped
  assert.equal(await access(r.id, carol), "viewer"); // in Sales
  assert.equal(await access(r.id, loner), null);
  assert.equal(await access(r.id, bob), "full"); // still full for alice's manager

  // "My departments" expands to alice's (Ops); a group share reaches its members.
  assert.equal(await updateReminder(await actor(alice), s.companyId, r.id, { ...base, shares: [{ kind: "mine", ref: null }, { kind: "group", ref: night }] }), null);
  assert.deepEqual(await saved(r.id), [`department:${ops}`, `group:${night}`].sort());
  assert.equal(await access(r.id, carol), null);
  assert.equal(await access(r.id, loner), "viewer");

  // The whole company covers everything else; sharing never needs approval.
  const v = validateInput(raw({ userIds: [alice], shareCompany: true, shareDepartmentIds: [sales] }), "UTC", "S");
  assert.deepEqual("input" in v && v.input?.shares, [{ kind: "company", ref: null }]);
  assert.equal(await updateReminder(await actor(alice), s.companyId, r.id, { ...base, shares: [{ kind: "company", ref: null }] }), null);
  assert.equal((await getReminder(s.companyId, r.id))!.status, "scheduled");
  assert.deepEqual((await getReminder(s.companyId, r.id))!.shareLabels, ["Everyone in the company"]);
  assert.equal(await access(r.id, carol), "viewer");
  assert.equal(await reminderAccess(other.companyId, { id: stranger, access: await loadAccess(other.companyId, stranger), email: "x" }, { id: r.id, createdBy: alice }), null);
});

test("named approvers: only they are asked and may decide; fallback if none can", async () => {
  const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
  const carol2 = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] }); // a second admin, to be the named one
  await q("update companies set approval_mode = 'named' where id = $1", [s.companyId]);
  await q("insert into company_approvers values ($1, $2)", [s.companyId, carol2]);
  const input = { title: "Wide", description: "", links: [], senderName: "S", sendAt: later(), ...oneTime, targets: [{ kind: "department" as const, ref: sales }] };
  const r = await createReminder(await actor(alice), s.companyId, input);
  assert.ok("id" in r);
  const asked = (await q("select user_id from notifications where reminder_id = $1 and kind = 'approval'", [r.id])).map((x) => x.user_id);
  assert.deepEqual(asked, [carol2]);
  assert.match((await decideReminder(await actor(admin), s.companyId, r.id, true))!, /named approvers/);
  assert.equal(await mayDecide(s.companyId, await actor(admin)), false);
  assert.equal(await decideReminder(await actor(carol2), s.companyId, r.id, true), null);

  // The named one is deactivated: everyone who can approve is asked again.
  await q(`update "user" set deactivated_at = now() where id = $1`, [carol2]);
  assert.equal(await mayDecide(s.companyId, await actor(admin)), true);
  await q("update companies set approval_mode = 'any' where id = $1", [s.companyId]);
  await q("delete from company_approvers where company_id = $1", [s.companyId]);
});

test("delete: hidden everywhere and cancelled; refused while sending", async () => {
  const r = await createReminder(await actor(alice), s.companyId, {
    title: "Gone soon", description: "", links: [], senderName: "S", sendAt: later(), ...oneTime, targets: [{ kind: "user", ref: bob }],
  });
  assert.ok("id" in r);
  const q = async (sql: string, params: unknown[]) => (await s.owner.query(sql, params)).rows;
  await q("insert into notifications (company_id, user_id, kind, reminder_id, text) values ($1, $2, 'reminder', $3, 'x')", [s.companyId, bob, r.id]);
  const [occ] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now(), 'sending') returning id", [s.companyId, r.id]);
  await q("insert into deliveries (company_id, reminder_id, occurrence_id, address) values ($1, $2, $3, 'b@x.test')", [s.companyId, r.id, occ.id]);
  assert.match((await deleteReminder(await actor(alice), s.companyId, r.id))!, /being sent/);
  await q("update deliveries set status = 'sent' where reminder_id = $1", [r.id]);

  assert.match((await deleteReminder(await actor(carol), s.companyId, r.id))!, /not found/);
  assert.equal(await deleteReminder(await actor(alice), s.companyId, r.id), null);
  assert.equal(await getReminder(s.companyId, r.id), null);
  for (const who of [admin, alice, bob]) {
    const { rows } = await searchReminders(s.companyId, await actor(who), "UTC", parseFilters({ q: "Gone soon" }));
    assert.deepEqual(rows, [], who);
  }
  assert.deepEqual(await q("select status, deleted_at is not null as deleted from reminders where id = $1", [r.id]), [{ status: "cancelled", deleted: true }]);
  assert.deepEqual(await q("select id from notifications where reminder_id = $1", [r.id]), []);
  assert.match((await deleteReminder(await actor(alice), s.companyId, r.id))!, /not found/);
});

test("only the next one: a one-time copy with the series' creator and files; the series skips that date", async () => {
  const tz = "UTC";
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const daily = { repeat: "daily", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" };
  const series = validateInput(raw({ departmentIds: [ops], when: "later", sendAtLocal: `${tomorrow}T09:00`, repeat: daily }), tz, "A").input!;
  const doc = checkFile("a.txt", new TextEncoder().encode("one"));
  assert.ok("file" in doc);
  const made = await createReminder(await actor(alice), s.companyId, series, [doc.file]);
  assert.ok("id" in made);
  const first = series.sendAt;

  // An admin (not the creator) changes just the next one: new title, an hour later.
  const one = validateInput(
    raw({ title: "Standup (moved)", departmentIds: [ops], when: "later", sendAtLocal: `${tomorrow}T10:00` }),
    tz,
    "A",
  ).input!;
  const refused = async (who: string, input: typeof one) => {
    const r = await detachOccurrence(await actor(who), s.companyId, made.id, input);
    return "error" in r ? r.error : "";
  };
  assert.match(await refused(carol, one), /not found/);
  assert.match(await refused(alice, series), /can't repeat/);
  const copy = await detachOccurrence(await actor(admin), s.companyId, made.id, one);
  assert.ok("id" in copy);

  const c = (await getReminder(s.companyId, copy.id))!;
  assert.equal(c.title, "Standup (moved)");
  assert.equal(c.recurrence, null);
  assert.equal(c.createdBy, alice);
  assert.equal(c.status, "scheduled");
  assert.equal(toLocalInput(c.sendAt, tz), `${tomorrow}T10:00`);
  assert.deepEqual((await listAttachments(s.companyId, copy.id)).map((a) => a.fileName), ["a.txt"]);
  assert.equal((await listAttachments(s.companyId, made.id)).length, 1); // the series keeps its own

  const after = (await getReminder(s.companyId, made.id))!;
  assert.equal(after.title, "Standup");
  assert.equal(after.sendAt.getTime(), first.getTime() + 86_400_000);
  const occ = await s.owner.query("select occurs_at, status from reminder_occurrences where reminder_id = $1", [made.id]);
  assert.deepEqual(occ.rows.map((o) => [o.occurs_at.getTime(), o.status]), [[first.getTime(), "skipped"]]);

  // Not for a paused series.
  assert.equal(await pauseReminder(await actor(alice), s.companyId, made.id), null);
  assert.match(await refused(alice, one), /scheduled repeating/);
});

test("shared done: for an occurrence nobody in the company is assigned to; not for assigned tasks", async () => {
  const q = async (sql: string, params: unknown[]) => (await s.owner.query(sql, params)).rows;
  const r = await createReminder(await actor(alice), s.companyId, {
    title: "Policy update", description: "", links: [], senderName: "S", sendAt: later(), ...oneTime, targets: [{ kind: "email", ref: "ext@else.test" }],
  });
  assert.ok("id" in r);
  const [occ] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now(), 'sending') returning id", [s.companyId, r.id]);
  assert.match((await setOccurrenceDone(await actor(carol), s.companyId, occ.id, true))!, /not found/);
  assert.equal(await setOccurrenceDone(await actor(alice), s.companyId, occ.id, true), null);
  assert.equal((await q("select done_at is not null as done from reminder_occurrences where id = $1", [occ.id]))[0].done, true);
  assert.equal(await setOccurrenceDone(await actor(alice), s.companyId, occ.id, false), null);
  assert.equal((await q("select done_at from reminder_occurrences where id = $1", [occ.id]))[0].done_at, null);

  await q("insert into task_assignments (company_id, reminder_id, occurrence_id, user_id) values ($1, $2, $3, $4)", [s.companyId, r.id, occ.id, bob]);
  assert.match((await setOccurrenceDone(await actor(alice), s.companyId, occ.id, true))!, /themselves/);
  const [later2] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now() + interval '1 day', 'skipped') returning id", [s.companyId, r.id]);
  assert.match((await setOccurrenceDone(await actor(alice), s.companyId, later2.id, true))!, /hasn't been sent/);
});

test("colour is personal: each person who can open it picks their own; nobody else's changes", async () => {
  const r = await createReminder(await actor(alice), s.companyId, { ...oneTime, title: "Colourful", description: "", links: [], senderName: "S", sendAt: later(), targets: [{ kind: "user", ref: bob }] });
  const id = (r as { id: string }).id;
  const me = async (u: string) => ({ ...(await actor(u)), email: `${u}@x.test` });
  const colors = async () =>
    Object.fromEntries((await s.owner.query("select user_id, color from reminder_colors where reminder_id = $1", [id])).rows.map((x) => [x.user_id, x.color]));
  assert.equal(await setMyColor(await me(alice), s.companyId, id, "banana"), null);
  assert.equal(await setMyColor(await me(admin), s.companyId, id, "peacock"), null); // view_all: can open it
  assert.deepEqual(await colors(), { [alice]: "banana", [admin]: "peacock" });
  assert.equal(await setMyColor(await me(alice), s.companyId, id, "grape"), null); // changes only hers
  assert.deepEqual(await colors(), { [alice]: "grape", [admin]: "peacock" });
  assert.match((await setMyColor(await me(alice), s.companyId, id, "neon"))!, /colour/);
  assert.match((await setMyColor(await me(carol), s.companyId, id, "tomato"))!, /not found/); // can't open it
  assert.equal(await setMyColor(await me(admin), s.companyId, id, ""), null); // back to the default
  assert.deepEqual(await colors(), { [alice]: "grape" });
  await cancelReminder(await actor(alice), s.companyId, id);
});

test("duplicate: a one-time copy owned by whoever duplicates it, approval checked as them, files copied", async () => {
  const series = await createReminder(
    await actor(admin),
    s.companyId,
    {
      ...oneTime,
      recurrence: { freq: "daily", interval: 1, end: { type: "never" } },
      title: "Company news",
      description: "Read it",
      links: [{ label: "x", url: "https://x.test" }],
      senderName: "HR",
      sendAt: later(),
      tags: ["news"],
      targets: [{ kind: "company", ref: null }],
    },
    [(checkFile("note.txt", new TextEncoder().encode("hello")) as { file: never }).file],
  );
  const orig = (series as { id: string }).id;
  // A copy as the admin: scheduled, one-time, same content and files; no comments.
  await s.owner.query("insert into comments (company_id, reminder_id, author_id, body) values ($1, $2, $3, 'hi')", [s.companyId, orig, admin]);
  const at = new Date(Date.now() + 2 * 86_400_000);
  const copy = (await duplicateReminder({ ...(await actor(admin)), email: "a@x.test" }, s.companyId, orig, at)) as { id: string };
  const [row] = (await s.owner.query("select created_by, status, recurrence, title, description, tags, send_at, sender_name from reminders where id = $1", [copy.id])).rows;
  assert.deepEqual(
    { ...row, send_at: row.send_at.getTime() },
    { created_by: admin, status: "scheduled", recurrence: null, title: "Company news", description: "Read it", tags: ["news"], send_at: at.getTime(), sender_name: "HR" },
  );
  assert.deepEqual((await listAttachments(s.companyId, copy.id)).map((f) => f.fileName), ["note.txt"]);
  assert.equal((await s.owner.query("select 1 from comments where reminder_id = $1", [copy.id])).rowCount, 0);

  // Alice's own reminder, for the refusals below.
  const mine = (await createReminder(await actor(alice), s.companyId, { ...oneTime, title: "Mine", description: "", links: [], senderName: "S", sendAt: later(), targets: [{ kind: "user", ref: bob }] })) as { id: string };
  // Once the admin's company-wide reminder is shared with the company, alice can open it, so she can copy it.
  await s.owner.query("insert into reminder_shares (reminder_id, company_id, kind, ref) values ($1, $2, 'company', null)", [orig, s.companyId]);
  const asAlice = (await duplicateReminder({ ...(await actor(alice)), email: "al@x.test" }, s.companyId, orig, at)) as { id: string };
  const [aliceCopy] = (await s.owner.query("select created_by, status from reminders where id = $1", [asAlice.id])).rows;
  assert.deepEqual(aliceCopy, { created_by: alice, status: "pending_approval" }); // the whole company is out of her scope

  // Refused: in the past; someone who can't open it; someone who can't create.
  assert.match(((await duplicateReminder({ ...(await actor(alice)), email: "" }, s.companyId, mine.id, new Date(Date.now() - 1000))) as { error: string }).error, /future/);
  assert.match(((await duplicateReminder({ ...(await actor(carol)), email: "" }, s.companyId, mine.id, at)) as { error: string }).error, /not found|can't create/);
  assert.match(((await duplicateReminder({ ...(await actor(bob)), email: "" }, s.companyId, mine.id, at)) as { error: string }).error, /can't create/); // bob has no role
  for (const id of [orig, copy.id, mine.id, asAlice.id]) await s.owner.query("update reminders set status = 'cancelled' where id = $1", [id]);
});

test("quick create: a reminder or task to yourself, never waiting for approval; refused when empty or in the past", async () => {
  const loner = await s.user({ roles: [MEMBER_ROLE_ID] }); // in no department
  const me = await actor(loner);
  const at = later();
  const base = { at, timeZone: "Asia/Kolkata", senderName: "Alerts | Co" };
  const r = (await quickCreate(me, s.companyId, { ...base, title: "  Call the bank ", kind: "reminder" })) as { id: string };
  const t = (await quickCreate(me, s.companyId, { ...base, title: "File the report", kind: "task" })) as { id: string };
  const row = async (id: string) =>
    (await s.owner.query("select title, status, created_by, is_task, due_after_minutes, recurrence, channels, time_zone, send_at from reminders where id = $1", [id])).rows[0];
  assert.deepEqual(
    { ...(await row(r.id)), send_at: (await row(r.id)).send_at.getTime() },
    { title: "Call the bank", status: "scheduled", created_by: loner, is_task: false, due_after_minutes: null, recurrence: null, channels: ["email"], time_zone: "Asia/Kolkata", send_at: at.getTime() },
  );
  assert.deepEqual([(await row(t.id)).is_task, (await row(t.id)).due_after_minutes, (await row(t.id)).status], [true, 60, "scheduled"]);
  const targets = (await s.owner.query("select kind, ref from reminder_targets where reminder_id = $1", [r.id])).rows;
  assert.deepEqual(targets, [{ kind: "user", ref: loner }]);

  const before = (await s.owner.query("select count(*)::int as n from reminders where created_by = $1", [loner])).rows[0].n;
  assert.match(((await quickCreate(me, s.companyId, { ...base, title: "   ", kind: "reminder" })) as { error: string }).error, /Title/);
  assert.match(((await quickCreate(me, s.companyId, { ...base, title: "x".repeat(201), kind: "reminder" })) as { error: string }).error, /Title/);
  assert.match(((await quickCreate(me, s.companyId, { ...base, at: new Date(Date.now() - 60_000), title: "Late", kind: "task" })) as { error: string }).error, /future/);
  assert.equal((await s.owner.query("select count(*)::int as n from reminders where created_by = $1", [loner])).rows[0].n, before); // nothing more
  for (const id of [r.id, t.id]) await s.owner.query("update reminders set status = 'cancelled' where id = $1", [id]);
});

// Far-future dates: a live worker never sends these mid-test.
const series = async (by: string, title: string, rule: Rule, anchorLocal: string, status = "scheduled") => {
  const r = (await createReminder(await actor(by), s.companyId, {
    ...oneTime,
    title,
    description: "",
    links: [],
    senderName: "S",
    recurrence: rule,
    anchorLocal,
    sendAt: new Date(`${anchorLocal}:00Z`),
    targets: [{ kind: "department", ref: ops }],
  })) as { id: string };
  if (status !== "scheduled") await s.owner.query("update reminders set status = $2 where id = $1", [r.id, status]);
  return r.id;
};
const rowOf = async (id: string) => (await s.owner.query("select status, send_at, anchor_local, recurrence, deleted_at, created_by from reminders where id = $1", [id])).rows[0];
const skipped = async (id: string) => (await s.owner.query("select occurs_at from reminder_occurrences where reminder_id = $1 and status = 'skipped' order by occurs_at", [id])).rows.map((r) => r.occurs_at.toISOString());
const Z = (t: string) => new Date(`${t}:00Z`);

test("move a one-time entry: new time, same recipients and approval; refused in the past or for someone who can't change it", async () => {
  const r = (await createReminder(await actor(alice), s.companyId, { ...oneTime, title: "Move me", description: "", links: [], senderName: "S", sendAt: Z("2031-03-02T09:00"), anchorLocal: "2031-03-02T09:00", targets: [{ kind: "user", ref: bob }] })) as { id: string };
  assert.deepEqual(await moveEntry(await actor(alice), s.companyId, r.id, Z("2031-03-02T09:00"), Z("2031-03-05T14:30"), "one"), { id: r.id });
  const row = await rowOf(r.id);
  assert.deepEqual([row.send_at.toISOString(), row.anchor_local, row.status], ["2031-03-05T14:30:00.000Z", "2031-03-05T14:30", "scheduled"]);
  assert.match(((await moveEntry(await actor(alice), s.companyId, r.id, row.send_at, new Date(Date.now() - 1000), "one")) as { error: string }).error, /future/);
  assert.match(((await moveEntry(await actor(carol), s.companyId, r.id, row.send_at, Z("2031-03-06T09:00"), "one")) as { error: string }).error, /not found/);
  await cancelReminder(await actor(alice), s.companyId, r.id);
});

test("move one date of a series: a one-time copy there, the series skips it; only real upcoming dates", async () => {
  const id = await series(alice, "Daily", { freq: "daily", interval: 1, end: { type: "never" } }, "2031-03-02T09:00");
  const me = await actor(alice);
  const moved = (await moveEntry(me, s.companyId, id, Z("2031-03-04T09:00"), Z("2031-03-04T15:00"), "one")) as { id: string };
  assert.notEqual(moved.id, id);
  const copy = await rowOf(moved.id);
  assert.deepEqual([copy.send_at.toISOString(), copy.recurrence, copy.status, copy.created_by], ["2031-03-04T15:00:00.000Z", null, "scheduled", alice]);
  assert.deepEqual(await skipped(id), ["2031-03-04T09:00:00.000Z"]);
  assert.equal((await rowOf(id)).send_at.toISOString(), "2031-03-02T09:00:00.000Z"); // "Next" unchanged
  assert.match(((await moveEntry(me, s.companyId, id, Z("2031-03-04T09:00"), Z("2031-03-04T16:00"), "one")) as { error: string }).error, /already skipped/);
  assert.match(((await moveEntry(me, s.companyId, id, Z("2031-03-05T10:00"), Z("2031-03-05T16:00"), "one")) as { error: string }).error, /isn't one of/);
  for (const x of [id, moved.id]) await cancelReminder(me, s.companyId, x);
});

test("move this and following: the series ends before; a new one carries on at the new day and time", async () => {
  const id = await series(alice, "Weekly sync", { freq: "weekly", interval: 1, weekdays: [0], end: { type: "never" } }, "2031-03-03T09:00"); // Mondays
  const me = await actor(alice);
  const split = (await moveEntry(me, s.companyId, id, Z("2031-03-17T09:00"), Z("2031-03-18T10:00"), "following")) as { id: string };
  const old = await rowOf(id);
  assert.deepEqual(old.recurrence.end, { type: "until", date: "2031-03-10" });
  assert.equal(old.send_at.toISOString(), "2031-03-03T09:00:00.000Z");
  const next = await rowOf(split.id);
  assert.deepEqual([next.anchor_local, next.recurrence.weekdays, next.send_at.toISOString(), next.created_by, next.status], ["2031-03-18T10:00", [1], "2031-03-18T10:00:00.000Z", alice, "scheduled"]);
  const targets = (await s.owner.query("select kind, ref from reminder_targets where reminder_id = $1", [split.id])).rows;
  assert.deepEqual(targets, [{ kind: "department", ref: ops }]);
  // A date skipped later in the series moves to the new one, at the new day and time.
  const id2 = await series(alice, "Weekly two", { freq: "weekly", interval: 1, weekdays: [0], end: { type: "never" } }, "2031-03-03T09:00");
  await s.owner.query("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, '2031-03-24T09:00Z', 'skipped')", [s.companyId, id2]);
  const split2 = (await moveEntry(me, s.companyId, id2, Z("2031-03-17T09:00"), Z("2031-03-18T10:00"), "following")) as { id: string };
  assert.deepEqual(await skipped(id2), []);
  assert.deepEqual(await skipped(split2.id), ["2031-03-25T10:00:00.000Z"]);
  for (const x of [id2, split2.id]) await cancelReminder(me, s.companyId, x);
  for (const x of [id, split.id]) await cancelReminder(me, s.companyId, x);
});

test("move all: the whole series shifts; waiting for approval, only all can move", async () => {
  const id = await series(alice, "Every day", { freq: "daily", interval: 1, end: { type: "never" } }, "2031-03-02T09:00");
  const me = await actor(alice);
  assert.deepEqual(await moveEntry(me, s.companyId, id, Z("2031-03-05T09:00"), Z("2031-03-05T11:00"), "all"), { id });
  const row = await rowOf(id);
  assert.deepEqual([row.anchor_local, row.send_at.toISOString()], ["2031-03-02T11:00", "2031-03-02T11:00:00.000Z"]);
  await cancelReminder(me, s.companyId, id);

  // A date moved with "this one", then the whole series moved: the skip moves too, so that date doesn't send twice.
  const both = await series(alice, "Both", { freq: "daily", interval: 1, end: { type: "never" } }, "2031-03-10T08:00");
  const copy = (await moveEntry(me, s.companyId, both, Z("2031-03-12T08:00"), Z("2031-03-12T16:30"), "one")) as { id: string };
  assert.deepEqual(await moveEntry(me, s.companyId, both, Z("2031-03-13T08:00"), Z("2031-03-13T09:30"), "all"), { id: both });
  assert.deepEqual(await skipped(both), ["2031-03-12T09:30:00.000Z"]);
  assert.equal((await s.owner.query("select replaces_occurs_at from reminders where id = $1", [copy.id])).rows[0].replaces_occurs_at.toISOString(), "2031-03-12T09:30:00.000Z");
  for (const x of [both, copy.id]) await cancelReminder(me, s.companyId, x);

  const waiting = await series(alice, "Waiting", { freq: "daily", interval: 1, end: { type: "never" } }, "2031-04-01T09:00", "pending_approval");
  assert.match(((await moveEntry(me, s.companyId, waiting, Z("2031-04-02T09:00"), Z("2031-04-02T10:00"), "one")) as { error: string }).error, /scheduled/);
  assert.match(((await moveEntry(me, s.companyId, waiting, Z("2031-04-02T09:00"), Z("2031-04-02T10:00"), "following")) as { error: string }).error, /scheduled/);
  assert.deepEqual(await moveEntry(me, s.companyId, waiting, Z("2031-04-02T09:00"), Z("2031-04-02T10:00"), "all"), { id: waiting });
  assert.equal((await rowOf(waiting)).status, "pending_approval");
  await cancelReminder(me, s.companyId, waiting);
});

test("delete from the calendar: one skips that date, following ends the series, all deletes it", async () => {
  const me = await actor(alice);
  const a = await series(alice, "Del one", { freq: "daily", interval: 1, end: { type: "never" } }, "2031-05-01T09:00");
  assert.equal(await deleteEntry(me, s.companyId, a, Z("2031-05-01T09:00"), "one"), null); // the next one: "Next" moves on
  assert.deepEqual(await skipped(a), ["2031-05-01T09:00:00.000Z"]);
  assert.equal((await rowOf(a)).send_at.toISOString(), "2031-05-02T09:00:00.000Z");
  assert.equal(await deleteEntry(me, s.companyId, a, Z("2031-05-05T09:00"), "following"), null);
  assert.deepEqual((await rowOf(a)).recurrence.end, { type: "until", date: "2031-05-04" });
  assert.equal(await deleteEntry(me, s.companyId, a, Z("2031-05-02T09:00"), "all"), null);
  assert.ok((await rowOf(a)).deleted_at);
  // Following from its very first date: nothing would be left, so it's deleted.
  const b = await series(alice, "Del all", { freq: "daily", interval: 1, end: { type: "never" } }, "2031-06-01T09:00");
  assert.equal(await deleteEntry(me, s.companyId, b, Z("2031-06-01T09:00"), "following"), null);
  assert.ok((await rowOf(b)).deleted_at);
  assert.match((await deleteEntry(await actor(carol), s.companyId, a, Z("2031-05-03T09:00"), "one"))!, /not found/);
});
