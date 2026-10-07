import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { db, withTenant } from "./index";
import { attachmentBlobs, attachments, departments, reminders, roles, slackInstallations, taskAssignments, user } from "./schema";
import { ALL_PERMISSIONS, COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "@/lib/permissions";

// Seeds as the owner (bypasses RLS), then reads through the app role.
const owner = new Pool({ connectionString: process.env.OWNER_DATABASE_URL });
const a = randomUUID();
const b = randomUUID();

after(async () => {
  for (const table of ["slack_installations", "reminders", "department_members", "user_roles", "roles", "departments"]) {
    await owner.query(`delete from ${table} where company_id = any($1)`, [[a, b]]);
  }
  await owner.query(`delete from "user" where company_id = any($1)`, [[a, b]]);
  await owner.query("delete from companies where id = any($1)", [[a, b]]);
  await owner.end();
  await db.$client.end();
});

test("tenant isolation", async () => {
  for (const id of [a, b]) {
    await owner.query("insert into companies (id, name, domain, time_zone) values ($1, $2, $2, 'UTC')", [id, id]);
    await owner.query("insert into departments (company_id, name) values ($1, 'HR')", [id]);
    await owner.query(`insert into "user" (id, name, email, company_id, updated_at) values ($1, $1, $1, $2, now())`, [
      `u-${id}`,
      id,
    ]);
  }

  const seen = await withTenant(a, (tx) => tx.select().from(departments));
  assert.deepEqual(seen.map((d) => d.companyId), [a]);

  const users = await withTenant(a, (tx) => tx.select().from(user));
  assert.deepEqual(users.map((u) => u.companyId), [a]);

  // No tenant set: fails closed.
  assert.equal((await db.select().from(departments)).length, 0);
  assert.equal((await db.select().from(user)).length, 0);

  // Writing into another tenant is rejected by WITH CHECK.
  await assert.rejects(withTenant(a, (tx) => tx.insert(departments).values({ companyId: b, name: "Ops" })));
});

test("reminders are tenant-isolated", async () => {
  await owner.query(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local)
     values ($1, $2, $3, 'B only', 'S', now() + interval '1 hour', 'scheduled', 'UTC', '2026-01-01T00:00')`,
    [b, `R-${b.slice(0, 6)}`, `u-${b}`],
  );
  const seen = await withTenant(a, (tx) => tx.select().from(reminders));
  assert.equal(seen.length, 0);
  await assert.rejects(
    withTenant(a, (tx) =>
      tx.insert(reminders).values({
        companyId: b,
        shortId: "R-XXXXXX",
        createdBy: `u-${a}`,
        title: "x",
        senderName: "s",
        sendAt: new Date(),
        status: "scheduled",
        timeZone: "UTC",
        anchorLocal: "2026-01-01T00:00",
      }),
    ),
  );
});

test("slack installations and task assignments are tenant-isolated", async () => {
  await owner.query(
    "insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'B ws', 'x', 'U')",
    [b, `T-${b}`],
  );
  assert.equal((await withTenant(a, (tx) => tx.select().from(slackInstallations))).length, 0);
  assert.equal((await withTenant(a, (tx) => tx.select().from(taskAssignments))).length, 0);
  assert.equal((await withTenant(a, (tx) => tx.select().from(attachments))).length, 0);
  assert.equal((await withTenant(a, (tx) => tx.select().from(attachmentBlobs))).length, 0);
  await assert.rejects(
    withTenant(a, (tx) =>
      tx.insert(slackInstallations).values({ companyId: b, teamId: "T-other", teamName: "x", botTokenEnc: "x", botUserId: "U" }),
    ),
  );
});

test("app role cannot read auth secrets", async () => {
  for (const table of ["session", "account", "verification"]) {
    await assert.rejects(db.$client.query(`select 1 from ${table}`), /permission denied/);
  }
});

// Reuses the companies, users and departments seeded by "tenant isolation" above.
test("roles: system roles shared and read-only, custom roles per tenant", async () => {
  await owner.query("insert into roles (company_id, name, permissions) values ($1, 'B only', '{}')", [b]);

  const names = (await withTenant(a, (tx) => tx.select().from(roles))).map((r) => r.name).sort();
  assert.deepEqual(names, ["Company Admin", "Member"]);

  const sys = await withTenant(a, (tx) =>
    tx.update(roles).set({ permissions: ["roles.manage"] }).where(eq(roles.id, MEMBER_ROLE_ID)).returning(),
  );
  assert.equal(sys.length, 0);
  assert.equal((await withTenant(a, (tx) => tx.delete(roles).where(eq(roles.id, MEMBER_ROLE_ID)).returning())).length, 0);
  await assert.rejects(withTenant(a, (tx) => tx.insert(roles).values({ companyId: null, name: "Sneaky", permissions: [] })));
});

test("loadAccess: admin gets everything, member its role, manager its departments", async () => {
  const [admin, member] = [`u-${a}`, `m-${a}`];
  await owner.query(`insert into "user" (id, name, email, company_id, updated_at) values ($1, $1, $1, $2, now())`, [member, a]);
  await owner.query("insert into user_roles (company_id, user_id, role_id) values ($1, $2, $3), ($1, $4, $5)", [
    a,
    admin,
    COMPANY_ADMIN_ROLE_ID,
    member,
    MEMBER_ROLE_ID,
  ]);
  const { rows } = await owner.query("select id from departments where company_id = $1", [a]);
  await owner.query("insert into department_members (company_id, department_id, user_id, is_manager) values ($1, $2, $3, true)", [
    a,
    rows[0].id,
    member,
  ]);

  const adminAccess = await loadAccess(a, admin);
  assert.equal(adminAccess.permissions.size, ALL_PERMISSIONS.length);

  const memberAccess = await loadAccess(a, member);
  assert.deepEqual([...memberAccess.permissions].sort(), ["departments.view", "reminders.create", "reminders.view", "users.view"]);
  assert.deepEqual([...memberAccess.managedDepartments], [rows[0].id]);

  // Same user id asked under another tenant: nothing.
  assert.equal((await loadAccess(b, member)).permissions.size, 0);
});
