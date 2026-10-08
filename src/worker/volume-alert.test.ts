import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { dispatchDue } from "./delivery";
import { volumeAlerts } from "./volume-alert";

const s = seeder();
let alice: string, reminderId: string, occ: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
let saved: number | null = null;

before(async () => {
  await s.company();
  alice = await s.user();
  [{ id: reminderId }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local)
     values ($1, $2, $3, 'Paused by suspension', 'S', now() + interval '1 hour', 'scheduled', 'UTC', '2030-01-01T00:00') returning id`,
    [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, alice],
  );
  await q("insert into reminder_targets values ($1, $2, 'user', $3, null)", [reminderId, s.companyId, alice]);
  [{ id: occ }] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now() - interval '1 day', 'sent') returning id", [s.companyId, reminderId]);
  saved = (await q("select daily_volume_alert from platform_settings where id = 1"))[0]?.daily_volume_alert ?? null;
});
after(async () => {
  await q("update platform_settings set daily_volume_alert = $1 where id = 1", [saved]);
  await q("delete from platform_alerts where company_id = $1", [s.companyId]);
  await s.cleanup();
  await ownerDb.$client.end();
});

test("a suspended company's due reminders wait", async () => {
  const inTwoHours = new Date(Date.now() + 2 * 3_600_000);
  const enqueue = async () => {};
  await q("update companies set suspended_at = now() where id = $1", [s.companyId]);
  assert.equal(await dispatchDue(enqueue, s.companyId, inTwoHours), 0);
  await q("update companies set suspended_at = null where id = $1", [s.companyId]);
  assert.equal(await dispatchDue(enqueue, s.companyId, inTwoHours), 1);
});

test("volume alert: once per company per day, only over the threshold", async () => {
  process.env.PLATFORM_OWNER_EMAILS = "owner1@platform.test, owner2@platform.test";
  for (let i = 0; i < 3; i++)
    await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, status) values ($1, $2, $3, $4, 'sent')", [s.companyId, reminderId, occ, `v${i}@x.test`]);
  const sent: string[] = [];
  const send = (async (m: { to: string }) => void sent.push(m.to)) as never;
  await q("update platform_settings set daily_volume_alert = 10 where id = 1");
  assert.equal(await volumeAlerts(send, s.companyId), 0);
  await q("update platform_settings set daily_volume_alert = 2 where id = 1");
  assert.equal(await volumeAlerts(send, s.companyId), 1);
  assert.deepEqual(sent.sort(), ["owner1@platform.test", "owner2@platform.test"]);
  assert.equal(await volumeAlerts(send, s.companyId), 0); // already alerted today
  assert.equal(sent.length, 2);
});
