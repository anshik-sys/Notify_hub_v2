import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { db, withTenant } from "./index";
import { departments, user } from "./schema";

// Seeds as the owner (bypasses RLS), then reads through the app role.
const owner = new Pool({ connectionString: process.env.OWNER_DATABASE_URL });
const a = randomUUID();
const b = randomUUID();

after(async () => {
  await owner.query("delete from departments where company_id = any($1)", [[a, b]]);
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

test("app role cannot read auth secrets", async () => {
  for (const table of ["session", "account", "verification"]) {
    await assert.rejects(db.$client.query(`select 1 from ${table}`), /permission denied/);
  }
});
