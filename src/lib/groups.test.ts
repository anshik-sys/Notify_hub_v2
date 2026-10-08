import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db, withTenant } from "@/db";
import { authDb } from "./auth";
import { addGroupMembers, createGroup, deleteGroup, getGroup, listGroups, removeGroupMember, renameGroup } from "./groups";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { createReminder, getReminder, outOfScope } from "./reminders";
import { resolveRecipients } from "./recipients";
import { seeder } from "./test-helpers";

const s = seeder();
const other = seeder();
let admin: string, alice: string, bob: string, carol: string, gone: string, stranger: string, ops: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const actor = async (id: string) => ({ id, access: await loadAccess(s.companyId, id) });
const later = () => new Date(Date.now() + 3_600_000);
const toGroup = (groupId: string) => ({
  title: "Standup",
  description: "",
  links: [],
  senderName: "S",
  sendAt: later(),
  recurrence: null,
  anchorLocal: "2026-01-01T00:00",
  timeZone: "UTC",
  isTask: false,
  dueAfterMinutes: null,
  channels: ["email" as const],
  tags: [],
  shares: [],
  targets: [{ kind: "group" as const, ref: groupId }],
});

before(async () => {
  await s.company();
  await other.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [alice, bob, carol, gone] = [
    await s.user({ roles: [MEMBER_ROLE_ID] }),
    await s.user({ roles: [MEMBER_ROLE_ID] }),
    await s.user({ roles: [MEMBER_ROLE_ID] }),
    await s.user({ roles: [MEMBER_ROLE_ID] }),
  ];
  await q(`update "user" set deactivated_at = now() where id = $1`, [gone]);
  stranger = await other.user({ roles: [MEMBER_ROLE_ID] });
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  await q("insert into department_members values ($1, $2, $3, false), ($1, $2, $4, false), ($1, $2, $5, false)", [s.companyId, ops, alice, bob, gone]);
});
after(async () => {
  await s.cleanup();
  await other.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

test("create (members can), unique names, edit rights", async () => {
  const noPerm = { id: alice, access: { permissions: new Set<never>(), managedDepartments: new Set<string>() } };
  assert.deepEqual(await createGroup(noPerm, s.companyId, "X"), { error: "You can't create groups." });
  const g = await createGroup(await actor(alice), s.companyId, "On-call");
  assert.ok("id" in g);
  assert.deepEqual(await createGroup(await actor(bob), s.companyId, " on-CALL "), { error: "A group with that name already exists." });
  assert.ok("id" in (await createGroup({ id: stranger, access: await loadAccess(other.companyId, stranger) }, other.companyId, "On-call"))); // other company: fine

  assert.match((await renameGroup(await actor(bob), s.companyId, g.id, "Mine now"))!, /Only the group's creator or an admin/);
  assert.match((await removeGroupMember(await actor(bob), s.companyId, g.id, alice))!, /Only the group's creator/);
  assert.equal(await renameGroup(await actor(alice), s.companyId, g.id, "On-call engineers"), null);
  assert.equal(await renameGroup(await actor(admin), s.companyId, g.id, "On-call team"), null); // groups.manage
  assert.equal((await getGroup(s.companyId, g.id))!.name, "On-call team");
  assert.equal(await getGroup(other.companyId, g.id), null);
});

test("members: active, own company only; resolved and scope-checked", async () => {
  const g = await createGroup(await actor(alice), s.companyId, "Ops crew");
  assert.ok("id" in g);
  assert.match(((await addGroupMembers(await actor(alice), s.companyId, g.id, [gone, stranger])) as { error: string }).error, /Pick someone/);
  assert.deepEqual(await addGroupMembers(await actor(alice), s.companyId, g.id, [bob, gone, stranger, alice]), { needApproval: 0 });
  assert.deepEqual((await getGroup(s.companyId, g.id))!.members.map((m) => m.id).sort(), [alice, bob].sort());
  assert.equal((await listGroups(s.companyId)).find((x) => x.id === g.id)!.members, 2);

  const targets = [{ kind: "group" as const, ref: g.id }, { kind: "department" as const, ref: ops }];
  const r = await withTenant(s.companyId, (tx) => resolveRecipients(tx, s.companyId, targets));
  assert.deepEqual(r.users.map((u) => u.id).sort(), [alice, bob].sort()); // de-duplicated, gone excluded
  const scope = (who: string, ts: typeof targets) =>
    withTenant(s.companyId, async (tx) => outOfScope(tx, s.companyId, await actor(who), ts, await resolveRecipients(tx, s.companyId, ts)));
  assert.deepEqual(await scope(alice, targets), []);
  assert.deepEqual(
    (await scope(carol, [targets[0]])).sort(),
    ["the Ops crew group (has people outside your departments)", `${alice}@${s.domain}`, `${bob}@${s.domain}`].sort(),
  );
});

test("adding an outsider sends upcoming reminders back for approval; delete blocked while used", async () => {
  const g = await createGroup(await actor(alice), s.companyId, "Standup crew");
  assert.ok("id" in g);
  await addGroupMembers(await actor(alice), s.companyId, g.id, [bob]);
  const r = await createReminder(await actor(alice), s.companyId, toGroup(g.id));
  assert.ok("id" in r);
  assert.equal((await getReminder(s.companyId, r.id))!.status, "scheduled"); // in scope

  // Adding a teammate keeps it; adding carol (another department) doesn't.
  assert.deepEqual(await addGroupMembers(await actor(alice), s.companyId, g.id, [alice]), { needApproval: 0 });
  assert.deepEqual(await addGroupMembers(await actor(alice), s.companyId, g.id, [carol]), { needApproval: 1 });
  const after = (await getReminder(s.companyId, r.id))!;
  assert.equal(after.status, "pending_approval");
  assert.ok(after.outOfScope.some((x) => x.includes("Standup crew group")));
  assert.equal((await q("select 1 from notifications where user_id = $1 and reminder_id = $2 and kind = 'approval'", [admin, r.id])).length, 1);

  assert.match((await deleteGroup(await actor(alice), s.companyId, g.id))!, /Used by 1 upcoming reminder/);
  await q("update reminders set status = 'cancelled' where id = $1", [r.id]);
  assert.equal(await deleteGroup(await actor(alice), s.companyId, g.id), null);
  assert.equal((await getReminder(s.companyId, r.id))!.targetLabels[0], "Deleted (group)");
});
