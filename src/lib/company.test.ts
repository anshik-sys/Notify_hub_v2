import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { companySettings, senderDefault, setApprovers, setDefaultSender, setRetention } from "./company";
import { COMPANY_ADMIN_ROLE_ID, MEMBER_ROLE_ID } from "./permissions";
import { seeder } from "./test-helpers";

const s = seeder();
let admin: string, member: string;
before(async () => {
  await s.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  member = await s.user({ roles: [MEMBER_ROLE_ID] });
});
after(async () => {
  await s.owner.query("delete from company_approvers where company_id = $1", [s.companyId]);
  await s.cleanup();
  await db.$client.end();
});

test("default sender, retention, approvers", async () => {
  assert.equal(senderDefault({ name: "Acme", defaultSenderName: null }), "Alerts | Acme");
  assert.equal(await setDefaultSender(s.companyId, "  HR | Acme "), null);
  assert.equal((await companySettings(s.companyId)).defaultSenderName, "HR | Acme");
  assert.match((await setDefaultSender(s.companyId, "x".repeat(101)))!, /at most 100/);
  assert.equal(await setDefaultSender(s.companyId, ""), null);
  assert.equal((await companySettings(s.companyId)).defaultSenderName, null);

  assert.match((await setRetention(s.companyId, 30))!, /listed periods/);
  assert.equal(await setRetention(s.companyId, 365), null);
  assert.equal((await companySettings(s.companyId)).retentionDays, 365);
  assert.equal(await setRetention(s.companyId, null), null);

  assert.match((await setApprovers(s.companyId, "named", [member]))!, /at least one/); // member can't approve: dropped
  assert.equal(await setApprovers(s.companyId, "named", [admin, member]), null);
  assert.deepEqual(await companySettings(s.companyId).then((c) => [c.approvalMode, c.approverIds]), ["named", [admin]]);
  assert.equal(await setApprovers(s.companyId, "any", []), null);
  assert.deepEqual(await companySettings(s.companyId).then((c) => [c.approvalMode, c.approverIds]), ["any", []]);
});
