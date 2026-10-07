import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "./auth";
import { acceptInvitation, createInvitation, findInvitation, hashToken } from "./invitations";
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

const invite = (token: string, email: string, roleIds: string[], expiresInMs = 3_600_000) =>
  s.owner.query(
    "insert into invitations (company_id, email, role_ids, invited_by, token_hash, expires_at) values ($1, $2, $3, $4, $5, $6)",
    [s.companyId, email, roleIds, adminId, hashToken(token), new Date(Date.now() + expiresInMs)],
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
  await invite("tok-1", email, [gone]);
  await s.owner.query("delete from roles where id = $1", [gone]); // deleted after inviting

  assert.deepEqual(await findInvitation("tok-1"), { email, companyName: "Test Co" });
  assert.equal(await findInvitation("wrong"), null);

  const joiner = await s.user({ company: false, email: email.toUpperCase() });
  await s.owner.query(`update "user" set email_verified = false where id = $1`, [joiner]);
  assert.equal(await acceptInvitation("tok-1", joiner), null);
  const { rows } = await s.owner.query(`select company_id, email_verified from "user" where id = $1`, [joiner]);
  assert.deepEqual(rows[0], { company_id: s.companyId, email_verified: true });
  const roles = await s.owner.query("select role_id from user_roles where user_id = $1", [joiner]);
  assert.deepEqual(roles.rows.map((r) => r.role_id), [MEMBER_ROLE_ID]);

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
