import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { deliverOne, dispatchDue, MAX_ATTEMPTS, sweep } from "./delivery";

const s = seeder();
let reminderId: string;
const mailpit = async (to: string) =>
  (await (await fetch(`http://localhost:8025/api/v1/search?query=to:${encodeURIComponent(to)}`)).json()).messages_count as number;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const failingSend = async () => {
  throw new Error("SMTP down");
};

before(async () => {
  await s.company();
  const creator = await s.user();
  const [alice, bob, gone] = [await s.user(), await s.user(), await s.user()];
  await q(`update "user" set deactivated_at = now() where id = $1`, [gone]);
  const [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  for (const u of [alice, bob, gone]) await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, u]);
  [{ id: reminderId }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status)
     values ($1, $2, $3, 'Fire drill', 'At 3pm', 'HR', now() - interval '1 minute', 'scheduled') returning id`,
    [s.companyId, `R-${s.companyId.slice(0, 6).toUpperCase()}`, creator],
  );
  await q("insert into reminder_targets values ($1, $2, 'department', $3), ($1, $2, 'email', $4)", [
    reminderId,
    s.companyId,
    ops,
    `ext@${s.domain}`,
  ]);
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
});

test("dispatch: parallel runs make one delivery per recipient", async () => {
  const enqueued: string[] = [];
  const enqueue = async (ids: string[]) => void enqueued.push(...ids);
  const [a, b] = await Promise.all([dispatchDue(enqueue, s.companyId), dispatchDue(enqueue, s.companyId)]);
  assert.equal(a + b, 1); // one run got it, the other skipped the locked row
  const rows = await q("select email, status from deliveries where reminder_id = $1 order by email", [reminderId]);
  assert.equal(rows.length, 3); // alice, bob, ext (not the deactivated one)
  assert.equal(enqueued.length, 3);
  assert.deepEqual((await q("select status from reminders where id = $1", [reminderId]))[0], { status: "sending" });
  assert.equal(await dispatchDue(enqueue, s.companyId), 0); // nothing left due
});

test("deliver: one email even when claimed twice; retries then fails", async () => {
  const rows = await q("select id, email from deliveries where reminder_id = $1 order by email", [reminderId]);
  const [first, second, third] = rows;

  const results = await Promise.all([deliverOne(first.id), deliverOne(first.id)]);
  assert.deepEqual(results.sort(), ["sent", "skipped"]);
  assert.equal(await mailpit(first.email), 1);

  await assert.rejects(deliverOne(second.id, failingSend), /SMTP down/);
  assert.deepEqual(
    (await q("select status, attempts, last_error from deliveries where id = $1", [second.id]))[0],
    { status: "queued", attempts: 1, last_error: "SMTP down" },
  );
  await q("update deliveries set attempts = $2 where id = $1", [second.id, MAX_ATTEMPTS - 1]);
  assert.equal(await deliverOne(second.id, failingSend), "failed");
  assert.equal(await deliverOne(second.id), "skipped"); // failed is final

  assert.deepEqual((await q("select status from reminders where id = $1", [reminderId]))[0], { status: "sending" });
  assert.equal(await deliverOne(third.id), "sent");
  // Nothing in flight any more: the reminder is done.
  assert.deepEqual((await q("select status from reminders where id = $1", [reminderId]))[0], { status: "sent" });
});

test("sweep: stuck sends fail (never resent), old queued rows come back for re-enqueue", async () => {
  const [{ id: stuck }] = await q(
    `insert into deliveries (company_id, reminder_id, email, status, attempts, updated_at)
     values ($1, $2, $3, 'sending', 1, now() - interval '11 minutes') returning id`,
    [s.companyId, reminderId, `stuck@${s.domain}`],
  );
  const [{ id: orphan }] = await q(
    `insert into deliveries (company_id, reminder_id, email, status, updated_at)
     values ($1, $2, $3, 'queued', now() - interval '3 minutes') returning id`,
    [s.companyId, reminderId, `orphan@${s.domain}`],
  );
  const orphans = await sweep();
  assert.ok(orphans.includes(orphan));
  const [row] = await q("select status, last_error from deliveries where id = $1", [stuck]);
  assert.equal(row.status, "failed");
  assert.match(row.last_error, /Not resent/);
  assert.equal(await mailpit(`stuck@${s.domain}`), 0);
});
