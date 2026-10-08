import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { departments, slackInstallations } from "@/db/schema";
import { auditCsv, csvCell, listAudit, parseAuditFilters } from "./audit";
import { seeder } from "./test-helpers";

const s = seeder();
const other = seeder();
let alice: string, bob: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const log = async () => q("select actor_id, actor_name, action, object_type, object_label, changes from audit_log where company_id = $1 order by id", [s.companyId]);

before(async () => {
  await s.company();
  await other.company();
  [alice, bob] = [await s.user(), await s.user()];
  await q(`update "user" set name = 'Alice' where id = $1`, [alice]);
});
after(async () => {
  await s.cleanup();
  await other.cleanup();
  await db.$client.end();
});

test("people's writes are recorded with the diff; system writes and noise aren't", async () => {
  const [{ id }] = await withTenant(s.companyId, (tx) => tx.insert(departments).values({ companyId: s.companyId, name: "Ops" }).returning(), alice);
  await withTenant(s.companyId, (tx) => tx.update(departments).set({ name: "Operations" }).where(eq(departments.id, id)), alice);
  await withTenant(s.companyId, (tx) => tx.update(departments).set({ name: "Operations" }).where(eq(departments.id, id)), alice); // no change
  await withTenant(s.companyId, (tx) => tx.update(departments).set({ name: "Silent" }).where(eq(departments.id, id))); // no actor
  await withTenant(s.companyId, (tx) => tx.delete(departments).where(eq(departments.id, id)), bob);
  const rows = await log();
  assert.deepEqual(
    rows.map((r) => [r.action, r.object_type, r.object_label, r.actor_id]),
    [
      ["create", "departments", "Ops", alice],
      ["update", "departments", "Operations", alice],
      ["delete", "departments", "Silent", bob],
    ],
  );
  assert.equal(rows[0].actor_name, "Alice");
  assert.deepEqual(rows[1].changes, { name: ["Ops", "Operations"] }); // only the changed column
  assert.ok(!("company_id" in rows[0].changes));
});

test("secrets never recorded; append-only; tenant-isolated", async () => {
  await q("delete from audit_log where company_id = $1", [s.companyId]);
  await q("insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'WS', 'secret-v1', 'U')", [s.companyId, `T-${s.companyId}`]);
  // Only the token changes: nothing recorded. Token plus a name: only the name.
  await withTenant(s.companyId, (tx) => tx.update(slackInstallations).set({ botTokenEnc: "secret-v2" }), alice);
  assert.equal((await log()).length, 0);
  await withTenant(s.companyId, (tx) => tx.update(slackInstallations).set({ botTokenEnc: "secret-v3", teamName: "WS 2" }), alice);
  const rows = await log();
  assert.deepEqual(rows.map((r) => r.changes), [{ team_name: ["WS", "WS 2"] }]);
  assert.ok(!JSON.stringify(await q("select * from audit_log where company_id = $1", [s.companyId])).includes("secret-v"));

  await assert.rejects(db.$client.query("delete from audit_log"), /permission denied/);
  await assert.rejects(db.$client.query("update audit_log set actor_name = 'x'"), /permission denied/);
  await assert.rejects(db.$client.query("insert into audit_log (company_id, action, object_type, changes) values ($1, 'create', 'x', '{}')", [s.companyId]), /permission denied/);
  assert.equal((await listAudit(other.companyId, "UTC", parseAuditFilters({}))).total, 0);
});

test("filters and CSV", async () => {
  await withTenant(s.companyId, (tx) => tx.insert(departments).values({ companyId: s.companyId, name: "=HYPERLINK(\"x\")" }), bob);
  const byBob = await listAudit(s.companyId, "UTC", parseAuditFilters({ actor: bob, type: "departments" }));
  assert.equal(byBob.total, 1);
  assert.equal((await listAudit(s.companyId, "UTC", parseAuditFilters({ actor: bob, type: "nonsense", action: "drop" }))).total, 1); // junk ignored
  assert.equal((await listAudit(s.companyId, "UTC", parseAuditFilters({ to: "2000-01-01" }))).total, 0);
  const csv = auditCsv(byBob.rows);
  assert.match(csv, /,"'=HYPERLINK\(""x""\)",/);
  assert.equal(csvCell("a,b\nc"), '"a,b\nc"');
  assert.equal(csvCell("-1"), "'-1");
  assert.equal(csvCell(null), "");
});
