import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "./auth";
import { COMPANY_ADMIN_ROLE_ID } from "./permissions";
import { createDepartments, dismissSetup, parseLines, setupStatus } from "./setup";
import { seeder } from "./test-helpers";

const s = seeder();
let admin: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
before(async () => {
  await s.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
});
after(async () => {
  await s.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

test("progress follows the data", async () => {
  let st = await setupStatus(s.companyId, admin);
  assert.deepEqual([st.done, st.complete, st.dismissed, st.steps.slack, st.steps.reminder], [0, false, false, false, false]);

  const r = await createDepartments(s.companyId, " Ops \n\nSales\nops\nOps");
  assert.deepEqual(r.created, ["Ops", "Sales"]);
  assert.deepEqual(await createDepartments(s.companyId, "Ops").then((x) => [x.created.length, x.skipped.length]), [0, 1]); // exists: reported
  st = await setupStatus(s.companyId, admin);
  assert.deepEqual([st.steps.departments, st.steps.managers, st.withoutManager], [true, false, 2]);

  await q("insert into invitations (company_id, email, role_ids, invited_by, token_hash, expires_at) values ($1, 'x@y.test', '{}', $2, 'h', now() + interval '1 day')", [s.companyId, admin]);
  st = await setupStatus(s.companyId, admin);
  assert.equal(st.steps.people, true);

  const depts = await q("select id from departments where company_id = $1", [s.companyId]);
  for (const d of depts) await q("insert into department_members values ($1, $2, $3, true)", [s.companyId, d.id, admin]);
  st = await setupStatus(s.companyId, admin);
  assert.deepEqual([st.done, st.complete], [3, true]);

  await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local)
     values ($1, $2, $3, 'First', 'S', now() + interval '1 day', 'scheduled', 'UTC', '2030-01-01T00:00')`,
    [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, admin],
  );
  await dismissSetup(s.companyId);
  st = await setupStatus(s.companyId, admin);
  assert.deepEqual([st.steps.reminder, st.dismissed], [true, true]);
});

test("parseLines", () => {
  assert.deepEqual(parseLines(" a \r\n\nb\nA\n c"), ["a", "b", "c"]);
  assert.equal(parseLines(Array.from({ length: 60 }, (_, i) => `d${i}`).join("\n")).length, 50);
});
