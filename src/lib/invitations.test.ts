import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "./auth";
import { acceptInvitation, createInvitation, findInvitation, hashToken, importInvitations } from "./invitations";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { seeder } from "./test-helpers";

const s = seeder();
let adminId: string;

before(async () => {
  await s.company();
  adminId = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
});
after(async () => {
  await s.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

const invite = (token: string, email: string, roleIds: string[], expiresInMs = 3_600_000, departmentIds: string[] = []) =>
  s.owner.query(
    "insert into invitations (company_id, email, role_ids, department_ids, invited_by, token_hash, expires_at) values ($1, $2, $3, $4, $5, $6, $7)",
    [s.companyId, email, roleIds, departmentIds, adminId, hashToken(token), new Date(Date.now() + expiresInMs)],
  );

test("createInvitation stores a hash, refuses members and escalation", async () => {
  const admin = { id: adminId, name: "Admin", access: await loadAccess(s.companyId, adminId) };
  const email = `new@${s.domain}`;
  assert.equal(await createInvitation(admin, s.companyId, ` NEW@${s.domain} `, [COMPANY_ADMIN_ROLE_ID]), null);
  const { rows } = await s.owner.query("select email, token_hash, role_ids from invitations where company_id = $1", [s.companyId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, email);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);

  // Inviting again replaces the pending invite.
  assert.equal(await createInvitation(admin, s.companyId, email, []), null);
  assert.equal((await s.owner.query("select 1 from invitations where company_id = $1", [s.companyId])).rowCount, 1);

  assert.match((await createInvitation(admin, s.companyId, "nope", []))!, /valid email/);
  assert.match((await createInvitation(admin, s.companyId, `d@${s.domain}`, [], ["00000000-0000-4000-8000-0000000000ff"]))!, /Unknown department/);
  const memberEmail = (await s.owner.query(`select email from "user" where id = $1`, [adminId])).rows[0].email;
  assert.match((await createInvitation(admin, s.companyId, memberEmail, []))!, /already a member/);

  const weak = { id: adminId, name: "Weak", access: { permissions: new Set(["users.create" as const]), managedDepartments: new Set<string>() } };
  assert.match((await createInvitation(weak, s.companyId, `x@${s.domain}`, [COMPANY_ADMIN_ROLE_ID]))!, /can't grant/);
});

test("acceptInvitation: single use, expiry, one company per user, roles", async () => {
  const email = `joiner@${s.domain}`;
  await s.owner.query("delete from invitations where company_id = $1", [s.companyId]);
  await s.owner.query("insert into roles (id, company_id, name, permissions) values (gen_random_uuid(), $1, 'Gone', '{}')", [s.companyId]);
  const gone = (await s.owner.query("select id from roles where company_id = $1", [s.companyId])).rows[0].id;
  const kept = (await s.owner.query("insert into departments (company_id, name) values ($1, 'Kept') returning id", [s.companyId])).rows[0].id;
  const dropped = (await s.owner.query("insert into departments (company_id, name) values ($1, 'Dropped') returning id", [s.companyId])).rows[0].id;
  await invite("tok-1", email, [gone], 3_600_000, [kept, dropped]);
  // Deleted after inviting: skipped on accept.
  await s.owner.query("delete from roles where id = $1", [gone]);
  await s.owner.query("delete from departments where id = $1", [dropped]);

  assert.deepEqual(await findInvitation("tok-1"), { email, companyName: "Test Co" });
  assert.equal(await findInvitation("wrong"), null);

  const joiner = await s.user({ company: false, email: email.toUpperCase() });
  await s.owner.query(`update "user" set email_verified = false where id = $1`, [joiner]);
  assert.equal(await acceptInvitation("tok-1", joiner), null);
  const { rows } = await s.owner.query(`select company_id, email_verified from "user" where id = $1`, [joiner]);
  assert.deepEqual(rows[0], { company_id: s.companyId, email_verified: true });
  const roles = await s.owner.query("select role_id from user_roles where user_id = $1", [joiner]);
  assert.deepEqual(roles.rows.map((r) => r.role_id), [MEMBER_ROLE_ID]);
  const memberships = await s.owner.query("select d.name, m.is_manager from department_members m join departments d on d.id = m.department_id where m.user_id = $1", [joiner]);
  assert.deepEqual(memberships.rows, [{ name: "Kept", is_manager: false }]);

  assert.match((await acceptInvitation("tok-1", joiner))!, /already used/);
  assert.equal(await findInvitation("tok-1"), null);

  await invite("tok-old", `late@${s.domain}`, [], -1000);
  const late = await s.user({ company: false, email: `late@${s.domain}` });
  assert.match((await acceptInvitation("tok-old", late))!, /expired/);

  // Already in a company: refused, and the invite is left unclaimed.
  await invite("tok-2", `taken@${s.domain}`, []);
  const taken = await s.user({ email: `taken@${s.domain}` });
  assert.match((await acceptInvitation("tok-2", taken))!, /can't accept/);
  assert.notEqual(await findInvitation("tok-2"), null);

  // Wrong account (email doesn't match the invite): refused.
  const other = await s.user({ company: false });
  assert.match((await acceptInvitation("tok-2", other))!, /can't accept/);
});

test("CSV import: all-or-nothing, names resolved, members skipped", async () => {
  const admin = { id: adminId, name: "Admin", access: await loadAccess(s.companyId, adminId) };
  await s.owner.query("insert into departments (company_id, name) values ($1, 'Operations'), ($1, 'Sales')", [s.companyId]);
  const count = async () => (await s.owner.query("select count(*)::int as n from invitations where company_id = $1 and accepted_at is null and email like 'imp%'", [s.companyId])).rows[0].n;
  const bad = await importInvitations(admin, s.companyId, `Email,Departments\nimp1@${s.domain},Operations\nnot-an-email,\nimp1@${s.domain},\nimp3@${s.domain},Opps\nimp4@${s.domain},`);
  assert.ok("errors" in bad);
  assert.deepEqual(bad.errors!.length, 3);
  assert.match(bad.errors!.join(" "), /Row 3: "not-an-email".*Row 4: .* more than once.*Row 5: unknown department "Opps"/);
  assert.equal(await count(), 0); // nothing created

  assert.deepEqual(await importInvitations(admin, s.companyId, "=cmd,x\n"), { errors: [`The file contains a cell starting with = + - or @ (a spreadsheet formula). Remove it and try again.`] });
  assert.match((await importInvitations(admin, s.companyId, "name\nx")).errors![0], /"email" column/);
  const big = ["email", ...Array.from({ length: 201 }, (_, i) => `imp-big${i}@${s.domain}`)].join("\n");
  assert.match((await importInvitations(admin, s.companyId, big)).errors![0], /At most 200/);

  const existing = `${adminId}@${s.domain}`;
  const ok = await importInvitations(admin, s.companyId, `email,departments,roles\r\nimp1@${s.domain},Operations;sales,Company Admin\r\n${existing},,\r\nIMP2@${s.domain},,\r\n`);
  assert.ok(!("errors" in ok));
  const r = ok as { invited: string[]; skipped: string[]; sendAll: () => Promise<void> };
  assert.deepEqual([r.invited, r.skipped], [[`imp1@${s.domain}`, `imp2@${s.domain}`], [existing]]);
  const row = (await s.owner.query("select role_ids, cardinality(department_ids) as d from invitations where email = $1", [`imp1@${s.domain}`])).rows[0];
  assert.deepEqual([row.role_ids.sort(), row.d], [[COMPANY_ADMIN_ROLE_ID, MEMBER_ROLE_ID].sort(), 2]);

  // A member can't hand out roles above their own.
  const member = await s.user({ roles: [MEMBER_ROLE_ID] });
  const m = { id: member, name: "M", access: await loadAccess(s.companyId, member) };
  assert.match((await importInvitations(m, s.companyId, `email,roles\nimp9@${s.domain},Company Admin`)).errors![0], /can't grant the Company Admin role/);
});
