import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createCompany } from "./onboarding";
import { authDb } from "./auth";

const owner = new Pool({ connectionString: process.env.OWNER_DATABASE_URL });
const domain = `${randomUUID()}.test`;
const [u1, u2] = [randomUUID(), randomUUID()];

after(async () => {
  await owner.query(`delete from "user" where id = any($1)`, [[u1, u2]]);
  await owner.query("delete from companies where domain = $1", [domain]);
  await owner.end();
  await authDb.$client.end();
});

test("onboarding", async () => {
  for (const id of [u1, u2]) {
    await owner.query(`insert into "user" (id, name, email, updated_at) values ($1, $1, $2, now())`, [id, `${id}@${domain}`]);
  }

  assert.match((await createCompany(u1, "x@gmail.com", "Acme", "UTC"))!, /work email/);
  assert.match((await createCompany(u1, `a@${domain}`, "Acme", "Mars/Base"))!, /time zone/);
  assert.equal(await createCompany(u1, `a@${domain}`, "Acme", "Asia/Kolkata"), null);

  const { rows } = await owner.query(`select c.domain from "user" u join companies c on c.id = u.company_id where u.id = $1`, [u1]);
  assert.equal(rows[0].domain, domain);

  // Same domain again: rejected, and the transaction left no stray company.
  assert.match((await createCompany(u2, `b@${domain}`, "Acme 2", "UTC"))!, /already exists/);
  // Already onboarded user: rejected.
  assert.match((await createCompany(u1, `a@other-${domain}`, "Other", "UTC"))!, /already belong/);
  const count = await owner.query("select count(*)::int as n from companies where domain like $1", [`%${domain}`]);
  assert.equal(count.rows[0].n, 1);
});
