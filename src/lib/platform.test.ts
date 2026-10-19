import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { authDb } from "./auth";
import { loadAccess, MEMBER_ROLE_ID } from "./permissions";
import {
  createCompanyForCustomer,
  deleteEmptyCompany,
  editCompany,
  ipAllowed,
  isOwnerEmail,
  ownerSignInAllowed,
  platformCompanies,
  platformQueue,
  platformSettingsRow,
  setMemberPermissions,
  setSuspended,
  setVolumeAlert,
} from "./platform";
import { lockPlatformSettings, seeder } from "./test-helpers";

const s = seeder();
let alice: string;
const created: string[] = [];
before(async () => {
  await s.company();
  alice = await s.user({ roles: [MEMBER_ROLE_ID] });
});
after(async () => {
  for (const id of created) {
    await s.owner.query("delete from invitations where company_id = $1", [id]);
    await s.owner.query("delete from companies where id = $1", [id]);
  }
  await s.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

test("owners and the IP allowlist", () => {
  const env = { PLATFORM_OWNER_EMAILS: " Owner@Acme.test, b@x.test", PLATFORM_ALLOWED_IPS: "203.0.113.5, 10.1.0.0/16, 2001:db8::1", NODE_ENV: "production" };
  assert.equal(isOwnerEmail("owner@acme.test", env), true);
  assert.equal(isOwnerEmail("eve@acme.test", env), false);
  assert.equal(ipAllowed("203.0.113.5", env), true);
  assert.equal(ipAllowed("10.1.200.7", env), true);
  assert.equal(ipAllowed("10.2.0.1", env), false);
  assert.equal(ipAllowed("2001:db8::1", env), true);
  assert.equal(ipAllowed("::ffff:203.0.113.5", env), true);
  assert.equal(ipAllowed("127.0.0.1", { ...env, PLATFORM_ALLOWED_IPS: "" }), false); // production without a list: nobody
  assert.equal(ipAllowed("127.0.0.1", { NODE_ENV: "development" }), true); // dev: localhost only
  assert.equal(ipAllowed("198.51.100.1", { NODE_ENV: "development" }), false);
});

test("cross-company functions need the platform flag and return aggregates", async () => {
  const flagError = (e: unknown) => /app\.platform/.test(String((e as { cause?: Error }).cause?.message ?? e));
  await assert.rejects(db.execute(sql`select * from platform_companies()`), flagError);
  await assert.rejects(db.execute(sql`select * from platform_queue()`), flagError);
  const mine = (await platformCompanies()).find((c) => c.id === s.companyId)!;
  assert.deepEqual([mine.people, mine.scheduled, mine.sent_24h, mine.suspended_at], [1, 0, 0, null]);
  const q = await platformQueue();
  assert.equal(typeof q.queued, "number");
});

test("owner accounts are platform-only", async () => {
  const solo = await s.user({ company: false });
  const member = await s.user();
  const email = async (id: string) => (await s.owner.query(`select email from "user" where id = $1`, [id])).rows[0].email as string;
  const [soloEmail, memberEmail] = [await email(solo), await email(member)];
  const env = { PLATFORM_OWNER_EMAILS: `${soloEmail},${memberEmail},new@owner.test` };
  assert.equal(await ownerSignInAllowed(` ${soloEmail.toUpperCase()} `, env), true);
  assert.equal(await ownerSignInAllowed(memberEmail, env), false); // listed, but in a company
  assert.equal(await ownerSignInAllowed("new@owner.test", env), true); // no account yet: may sign up
  assert.equal(await ownerSignInAllowed("eve@x.test", env), false); // not listed
});

const noContact = { contactEmail: "", contactPhone: "" };

test("create, suspend, delete only when empty", async () => {
  const domain = `${randomUUID().slice(0, 8)}.example.com`;
  assert.match((await createCompanyForCustomer({ id: alice, name: "Owner", email: "o@x" }, { name: "New Co", domain, timeZone: "UTC", adminEmail: "a@other.com", ...noContact })).error!, /must be at/);
  const base = { name: "New Co", domain, timeZone: "UTC", adminEmail: `boss@${domain}` };
  assert.match((await createCompanyForCustomer({ id: alice, name: "Owner", email: "o@x" }, { ...base, contactEmail: "", contactPhone: "call me" })).error!, /contact phone/);
  const r = await createCompanyForCustomer({ id: alice, name: "Owner", email: "o@x" }, { ...base, contactEmail: " Ops@Acme.com ", contactPhone: "+971 4 123 4567" });
  assert.ok(r.id && !r.error, r.error);
  created.push(r.id!);
  const [row] = (await s.owner.query("select contact_email, contact_phone from companies where id = $1", [r.id])).rows;
  assert.deepEqual([row.contact_email, row.contact_phone], ["ops@acme.com", "+971 4 123 4567"]);
  const inv = (await s.owner.query("select email, role_ids from invitations where company_id = $1", [r.id])).rows;
  assert.deepEqual(inv.map((i) => [i.email, i.role_ids.includes("00000000-0000-4000-8000-000000000001")]), [[`boss@${domain}`, true]]);
  assert.match((await createCompanyForCustomer({ id: alice, name: "O", email: "o@x" }, { name: "Dup", domain, timeZone: "UTC", adminEmail: `x@${domain}`, ...noContact })).error!, /already exists/);

  assert.equal(await setSuspended(s.companyId, true), null);
  assert.ok((await platformCompanies()).find((c) => c.id === s.companyId)!.suspended_at);
  assert.equal(await setSuspended(s.companyId, false), null);

  assert.match((await deleteEmptyCompany(r.id!))!, /isn't empty/); // the pending invitation references it
  await s.owner.query("delete from invitations where company_id = $1", [r.id]);
  assert.equal(await deleteEmptyCompany(r.id!), null);
  assert.match((await deleteEmptyCompany(s.companyId))!, /isn't empty/); // has people
});

test("settings: volume alert and the Member role", async () => {
  const release = await lockPlatformSettings();
  const before = await platformSettingsRow();
  try {
    assert.match((await setVolumeAlert(0))!, /whole number/);
    assert.equal(await setVolumeAlert(500), null);
    assert.equal((await platformSettingsRow()).dailyVolumeAlert, 500);
    assert.equal(await setMemberPermissions(["reminders.create", "bogus", "users.view"]), null);
    assert.deepEqual([...(await loadAccess(s.companyId, alice)).permissions].sort(), ["reminders.create", "users.view"]);
  } finally {
    await setVolumeAlert(before.dailyVolumeAlert);
    await setMemberPermissions(before.memberPermissions);
    await release();
  }
  assert.deepEqual((await platformSettingsRow()).memberPermissions.sort(), before.memberPermissions.sort());
});

test("the daily email limit: whole numbers 1 to 1,000,000, saved per company", async () => {
  const edit = (dailyEmailLimit: string) =>
    editCompany(s.companyId, { name: "Test Co", domain: s.domain, timeZone: "UTC", contactEmail: "", contactPhone: "", dailyEmailLimit });
  for (const bad of ["0", "-5", "2.5", "abc", "", "1000001"]) assert.match((await edit(bad))!, /whole number/, bad);
  assert.equal(await edit("500"), null);
  assert.equal((await s.owner.query("select daily_email_limit from companies where id = $1", [s.companyId])).rows[0].daily_email_limit, 500);
});
