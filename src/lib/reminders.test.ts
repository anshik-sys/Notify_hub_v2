import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db, withTenant } from "@/db";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import {
  cancelReminder,
  createReminder,
  decideReminder,
  getReminder,
  outOfScope,
  type RawReminder,
  resolveRecipients,
  type Target,
  updateReminder,
  validateInput,
} from "./reminders";
import { seeder } from "./test-helpers";

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
  ...over,
});
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
  const input = (targets: Target[]) => ({ title: "T", description: "", links: [], senderName: "S", sendAt: new Date(), targets });

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
