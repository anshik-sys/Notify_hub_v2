import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { sendMail } from "@/lib/mail";
import { remindBefore } from "@/lib/reminders";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { deliverOne, dispatchRemindBefore, remindDue } from "./delivery";

// PRD 14.5 "remind before due" (RB1-RB9), from the form's rules to the worker.
const s = seeder();
let creator: string, alice: string, bob: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const DUE = new Date("2031-03-10T10:00:00Z");
const ahead = (min: number) => new Date(DUE.getTime() - min * 60_000);
let n = 0;
// A task already sent (one occurrence), due at DUE; alice still open, bob done.
async function task(set = "", outsideOnly = false) {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes,
       notify_before, channels)
     values ($1, $2, $3, 'Expenses', 'Olga', $4, 'sent', 'UTC', '2031-03-01T10:00', true, 12960, '{1440,60}', '{email}') returning id`,
    [s.companyId, `R-${s.companyId.slice(0, 6)}-${n++}`, creator, new Date("2031-03-01T10:00:00Z")],
  );
  const [{ id: occ }] = await q(
    "insert into reminder_occurrences (company_id, reminder_id, occurs_at, status, due_at) values ($1, $2, '2031-03-01T10:00Z', 'sent', $3) returning id",
    [s.companyId, id, DUE],
  );
  if (outsideOnly)
    await q("insert into deliveries (company_id, reminder_id, occurrence_id, channel, address, status) values ($1, $2, $3, 'email', 'out@example.com', 'sent')", [s.companyId, id, occ]);
  else
    await q("insert into task_assignments (company_id, reminder_id, occurrence_id, user_id, done_at) values ($1, $2, $3, $4, null), ($1, $2, $3, $5, now())", [
      s.companyId,
      id,
      occ,
      alice,
      bob,
    ]);
  if (set) await q(`update reminders set ${set} where id = $1`, [id]);
  return { id: id as string, occ: occ as string };
}
const dispatch = (now: Date) => dispatchRemindBefore(async () => {}, s.companyId, now);
const sent = async (id: string) =>
  (await q("select address, before_minutes from deliveries where reminder_id = $1 and kind = 'due' order by before_minutes desc", [id])).map(
    (r) => `${r.address}:${r.before_minutes}`,
  );

before(async () => {
  await s.company();
  [creator, alice, bob] = [await s.user(), await s.user(), await s.user()];
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
});

test("remindBefore: presets, custom, limits, and the 1-day default dropped when it can't fit", () => {
  assert.deepEqual(remindBefore({ remindBefore: ["60", "1440"] }, 3000), { minutes: [1440, 60] });
  assert.deepEqual(remindBefore({ remindBefore: [], remindCustom: "3", remindUnit: "hours" }, 3000), { minutes: [180] });
  assert.deepEqual(remindBefore({ remindBefore: ["1440"] }, 120), { minutes: [] }); // the default, due within a day
  assert.ok("error" in remindBefore({ remindBefore: ["1440", "60"] }, 120)); // RB5
  assert.ok("error" in remindBefore({ remindBefore: ["45"] }, 3000));
  assert.ok("error" in remindBefore({ remindCustom: "0", remindUnit: "days" }, 3000));
  assert.ok("error" in remindBefore({ remindCustom: "2", remindUnit: "weeks" }, 30000));
  assert.deepEqual(remindBefore({ remindBefore: ["60", "1440", "2880", "10080"], remindCustom: "5", remindUnit: "hours" }, 20000), { minutes: [10080, 2880, 1440, 300, 60] });
  assert.equal(remindDue(DUE, [1440, 60], ahead(1441)), undefined);
  assert.equal(remindDue(DUE, [1440, 60], ahead(30)), 60);
  assert.equal(remindDue(DUE, [1440, 60], ahead(-1)), undefined);
});

test("each time once, nearest only, to assignees not done", async () => {
  const t = await task();
  const email = (await q(`select email from "user" where id = $1`, [alice]))[0].email.toLowerCase();
  await dispatch(ahead(1441));
  assert.deepEqual(await sent(t.id), []);
  await dispatch(ahead(1440));
  await dispatch(ahead(600));
  assert.deepEqual(await sent(t.id), [`${email}:1440`]);
  await dispatch(ahead(60));
  assert.deepEqual(await sent(t.id), [`${email}:1440`, `${email}:60`]);
  const bell = await q("select text from notifications where user_id = $1 and reminder_id = $2 order by created_at", [alice, t.id]);
  assert.equal(bell.length, 2);
  assert.match(bell[0].text, /^Due in 1 day/);
});

test("late: only the nearest; outside-only goes to the address; cancelled, deleted, none get nothing", async () => {
  const late = await task();
  await dispatch(ahead(30));
  assert.equal((await sent(late.id)).length, 1);
  assert.match((await sent(late.id))[0], /:60$/);
  const outside = await task("", true);
  await dispatch(ahead(60));
  assert.deepEqual(await sent(outside.id), ["out@example.com:60"]);
  for (const set of ["status = 'cancelled'", "deleted_at = now()", "notify_before = '{}'"]) {
    const x = await task(set);
    await dispatch(ahead(60));
    assert.deepEqual(await sent(x.id), [], set);
  }
});

test("marked done after it was queued: dropped, not sent; otherwise the email says when it's due", async () => {
  const t = await task();
  await dispatch(ahead(1440));
  const [{ id: d }] = await q("select id from deliveries where reminder_id = $1 and kind = 'due'", [t.id]);
  const box: Parameters<typeof sendMail>[0][] = [];
  const send = (async (m: Parameters<typeof sendMail>[0]) => void box.push(m)) as unknown as typeof sendMail;
  await q("update task_assignments set done_at = now() where occurrence_id = $1 and user_id = $2", [t.occ, alice]);
  assert.equal(await deliverOne(d, send), "dropped");
  assert.equal(box.length, 0);
  const u = await task();
  await dispatch(ahead(1440));
  const [{ id: d2 }] = await q("select id from deliveries where reminder_id = $1 and kind = 'due'", [u.id]);
  assert.equal(await deliverOne(d2, send), "sent");
  assert.match(box[0].subject, /^Due in 1 day: Expenses$/);
  assert.match(box[0].text, /due 10 Mar 2031/);
});
