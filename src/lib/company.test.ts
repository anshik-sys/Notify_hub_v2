import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { companyBrand, companySettings, logoFile, removeLogo, senderDefault, setApprovers, setContact, setDefaultSender, setLogo, setProfile, setRetention } from "./company";
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

test("contact email and phone", async () => {
  assert.equal(await setContact(s.companyId, " Ops@Acme.com ", " +1 (415) 555-0100 "), null);
  assert.deepEqual(await companySettings(s.companyId).then((c) => [c.contactEmail, c.contactPhone]), ["ops@acme.com", "+1 (415) 555-0100"]);
  assert.match((await setContact(s.companyId, "not-an-email", ""))!, /contact email/);
  assert.match((await setContact(s.companyId, "", "555-CALL"))!, /contact phone/);
  assert.match((await setContact(s.companyId, "", "12345"))!, /contact phone/); // too few digits
  assert.equal(await setContact(s.companyId, "", ""), null);
  assert.deepEqual(await companySettings(s.companyId).then((c) => [c.contactEmail, c.contactPhone]), [null, null]);
});

test("admins edit the company's name and time zone, never the domain", async () => {
  assert.match((await setProfile(s.companyId, " ", "UTC"))!, /1–100/);
  assert.match((await setProfile(s.companyId, "Acme", "Mars/Base"))!, /time zone/);
  assert.equal(await setProfile(s.companyId, "  Acme Ltd ", "Asia/Dubai"), null);
  const row = (await s.owner.query("select name, time_zone, domain from companies where id = $1", [s.companyId])).rows[0];
  assert.deepEqual([row.name, row.time_zone, row.domain], ["Acme Ltd", "Asia/Dubai", s.domain]);
});

test("logo: real images only, small, replaceable, removable", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d20000000049454e44ae426082", "hex");
  assert.equal((await companyBrand(s.companyId)).logoVersion, null);
  assert.match((await setLogo(s.companyId, "logo.png", new TextEncoder().encode("not an image")))!, /./);
  assert.match((await setLogo(s.companyId, "logo.svg", new TextEncoder().encode("<svg onload=alert(1)>")))!, /./);
  assert.match((await setLogo(s.companyId, "big.png", new Uint8Array(300 * 1024)))!, /256 KB/);
  assert.match((await setLogo(s.companyId, "doc.pdf", new TextEncoder().encode("%PDF-1.4 x")))!, /PNG, JPEG, GIF or WebP/);

  assert.equal(await setLogo(s.companyId, "logo.png", png), null);
  const first = (await companyBrand(s.companyId)).logoVersion;
  assert.ok(first);
  assert.equal((await logoFile(s.companyId))!.contentType, "image/png");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await setLogo(s.companyId, "logo2.png", png), null); // replace: one row, new version
  assert.notEqual((await companyBrand(s.companyId)).logoVersion, first);
  assert.equal((await s.owner.query("select count(*)::int as n from company_logos where company_id = $1", [s.companyId])).rows[0].n, 1);

  await removeLogo(s.companyId);
  assert.equal(await logoFile(s.companyId), null);
  assert.equal((await companyBrand(s.companyId)).logoVersion, null);
});
