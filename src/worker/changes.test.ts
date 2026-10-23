import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { seeder } from "@/lib/test-helpers";
import { ownerDb } from "./db";
import { deliverOne, dispatchChanges, dispatchInvites } from "./delivery";

// PRD 14.3 change and cancel notices from the worker (UP1-UP7).
const s = seeder();
let creator: string, alice: string, bob: string, carol: string, ops: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const START = new Date("2031-03-03T10:00:00Z");
let n = 0;
const run = async () => {
  const ids: string[] = [];
  await dispatchChanges(async (x) => void ids.push(...x), s.companyId);
  await dispatchInvites(async (x) => void ids.push(...x), s.companyId);
  return ids;
};
async function event(set = "") {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_event, duration_minutes, location, channels)
     values ($1, $2, $3, 'Planning', 'Olga', $4, 'scheduled', 'UTC', '2031-03-03T10:00', true, 60, 'Room 2', '{email}') returning id`,
    [s.companyId, `C-${s.companyId.slice(0, 6)}-${n++}`, creator, START],
  );
  await q("insert into reminder_targets values ($1, $2, 'department', $3)", [id, s.companyId, ops]);
  if (set) await q(`update reminders set ${set} where id = $1`, [id]);
  await run(); // announced v0 and the invites
  return id as string;
}
const who = (u: string) => ({ [alice]: "alice", [bob]: "bob", [carol]: "carol" })[u] ?? u;
const notices = async (id: string) =>
  (await q("select kind, version, user_id, detail from deliveries where reminder_id = $1 and kind in ('update','cancel','uninvite') order by version, kind, user_id", [id])).map(
    (r) => `${r.kind}:${r.version}:${who(r.user_id)}`,
  ).sort();
const capture = () => {
  const box: { subject: string; text: string; attachments?: { content: Buffer }[] }[] = [];
  return { box, send: async (m: (typeof box)[number]) => void box.push(m) as never };
};

before(async () => {
  await s.company();
  [creator, alice, bob, carol] = [await s.user(), await s.user(), await s.user(), await s.user()];
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  for (const u of [alice, bob]) await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, u]);
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
});

test("UP2: description only: no notice; UP1: time and place: 'Updated' with what changed, next version, answers kept", async () => {
  const id = await event();
  await q("insert into event_responses (reminder_id, user_id, company_id, answer) values ($1, $2, $3, 'yes')", [id, alice, s.companyId]);
  await q("update reminders set description = 'New agenda' where id = $1", [id]);
  await run();
  assert.deepEqual(await notices(id), []);
  await q("update reminders set send_at = '2031-03-03T11:00Z', location = 'Room 5' where id = $1", [id]);
  await run();
  await run(); // once
  assert.deepEqual(await notices(id), ["update:1:alice", "update:1:bob"]);
  const [{ detail }] = await q("select detail from deliveries where reminder_id = $1 and kind = 'update' limit 1", [id]);
  assert.match(detail, /When: 3 Mar 2031, 11:00 – 12:00 \(UTC\) \(was 3 Mar 2031, 10:00 – 11:00 \(UTC\)\)/);
  assert.match(detail, /Where: Room 5 \(was Room 2\)/);
  const [d] = await q("select id from deliveries where reminder_id = $1 and kind = 'update' and user_id = $2", [id, alice]);
  const mail = capture();
  assert.equal(await deliverOne(d.id, mail.send), "sent");
  assert.equal(mail.box[0].subject, "Updated: Planning");
  const ics = mail.box[0].attachments![0].content.toString();
  assert.match(ics, /METHOD:REQUEST/);
  assert.match(ics, /SEQUENCE:1/);
  assert.match(ics, /DTSTART:20310303T110000Z/);
  assert.deepEqual(await q("select answer from event_responses where reminder_id = $1", [id]), [{ answer: "yes" }]);
});

test("UP4: a removed guest gets 'no longer invited' with a cancelling .ics; UP3: an added one only the invite", async () => {
  const id = await event();
  await q("delete from department_members where user_id = $1", [bob]);
  await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, carol]);
  await run();
  assert.deepEqual(await notices(id), ["uninvite:1:bob"]);
  assert.equal((await q("select 1 from deliveries where reminder_id = $1 and kind = 'invite' and user_id = $2", [id, carol])).length, 1);
  const [d] = await q("select id from deliveries where reminder_id = $1 and kind = 'uninvite'", [id]);
  const mail = capture();
  await deliverOne(d.id, mail.send);
  assert.equal(mail.box[0].subject, "You’re no longer invited: Planning");
  assert.match(mail.box[0].attachments![0].content.toString(), /METHOD:CANCEL[\s\S]*STATUS:CANCELLED/);
  await q("delete from department_members where user_id = $1", [carol]);
  await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, bob]);
});

test("UP5: cancelled or deleted: 'Cancelled' to everyone invited, once; a past one: nothing", async () => {
  const id = await event();
  const gone = await event();
  await q("update reminders set status = 'cancelled' where id = $1", [id]);
  await q("update reminders set status = 'cancelled', deleted_at = now() where id = $1", [gone]);
  await run();
  await run();
  assert.deepEqual(await notices(id), ["cancel:1:alice", "cancel:1:bob"]);
  assert.deepEqual(await notices(gone), ["cancel:1:alice", "cancel:1:bob"]);
  const past = await event("send_at = now() + interval '1 hour'");
  await q("update reminders set send_at = now() - interval '3 hours', status = 'cancelled' where id = $1", [past]);
  await run();
  assert.deepEqual(await notices(past), []);
});

test("UP5: several workers at once still send 'Cancelled' once", async () => {
  const ids = [await event(), await event(), await event()];
  await q("update reminders set status = 'cancelled' where id = any($1)", [ids]);
  // ponytail: a race, so it can pass by luck; it failed this way in full runs before the fix.
  await Promise.all([run(), run(), run(), run()]);
  for (const id of ids) assert.deepEqual(await notices(id), ["cancel:1:alice", "cancel:1:bob"]);
});

test("UP6: a date of a series skipped or moved: 'Not on' and an EXDATE", async () => {
  const id = await event(`recurrence = '{"freq":"weekly","interval":1,"end":{"type":"never"}}'`);
  await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, '2031-03-10T10:00Z', 'skipped')", [s.companyId, id]);
  await run();
  assert.deepEqual(await notices(id), ["update:1:alice", "update:1:bob"]);
  const [d] = await q("select id, detail from deliveries where reminder_id = $1 and kind = 'update' limit 1", [id]);
  assert.match(d.detail, /Not on: 10 Mar 2031, 10:00/);
  const mail = capture();
  await deliverOne(d.id, mail.send);
  assert.match(mail.box[0].attachments![0].content.toString(), /EXDATE;TZID=UTC:20310310T100000/);
});

test("UP7: while a change waits for approval nothing goes; once approved, the update does", async () => {
  const id = await event();
  await q("update reminders set status = 'pending_approval', location = 'Room 9' where id = $1", [id]);
  await run();
  assert.deepEqual(await notices(id), []);
  await q("update reminders set status = 'scheduled' where id = $1", [id]);
  await run();
  assert.deepEqual(await notices(id), ["update:1:alice", "update:1:bob"]);
});
