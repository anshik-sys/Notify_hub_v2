import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eventGuests, respond, respondByToken, rsvpTarget } from "./events";
import { rsvpUrl } from "./invite";
import { seeder } from "./test-helpers";

const s = seeder();
let creator: string, alice: string, bob: string, carol: string, ops: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
let n = 0;
async function event(fields = "") {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local, is_event, duration_minutes)
     values ($1, $2, $3, 'Planning', 'Olga', now() + interval '1 day', 'scheduled', 'UTC', '2026-01-01T00:00', true, 60) returning id`,
    [s.companyId, `E-${s.companyId.slice(0, 6)}-${n++}`, creator],
  );
  await q("insert into reminder_targets values ($1, $2, 'department', $3)", [id, s.companyId, ops]);
  if (fields) await q(`update reminders set ${fields} where id = $1`, [id]);
  return id as string;
}
const token = (eventId: string, userId: string) => decodeURIComponent(rsvpUrl(s.companyId, eventId, userId, "yes").split("/rsvp/")[1].split("?")[0]);

before(async () => {
  await s.company();
  [creator, alice, bob, carol] = [await s.user(), await s.user(), await s.user(), await s.user()];
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]);
  for (const u of [creator, alice, bob]) await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, u]);
});
after(() => s.cleanup());

test("a guest answers and changes it; the organiser is told each time", async () => {
  const id = await event();
  assert.equal(await respond(s.companyId, alice, id, "yes", alice), null);
  assert.equal(await respond(s.companyId, alice, id, "yes", alice), null); // a repeat tells nobody again
  assert.equal(await respond(s.companyId, alice, id, "maybe", alice), null);
  assert.deepEqual(await q("select answer from event_responses where reminder_id = $1", [id]), [{ answer: "maybe" }]);
  const told = await q("select user_id, kind, text from notifications where reminder_id = $1 order by created_at", [id]);
  assert.deepEqual(
    told.map((t) => [t.user_id, t.kind, t.text]),
    [
      [creator, "rsvp", `${alice} answered Yes`],
      [creator, "rsvp", `${alice} answered Maybe (was Yes)`],
    ],
  );
  // Logged, with the guest as the actor.
  const [audit] = await q("select actor_id from audit_log where object_type = 'event_responses' and object_id = $1 limit 1", [id]);
  assert.equal(audit.actor_id, alice);
});

test("refused: not a guest, the organiser, a bad answer, not scheduled, ended, deleted", async () => {
  const id = await event();
  assert.match((await respond(s.companyId, carol, id, "yes", carol))!, /not invited/);
  assert.match((await respond(s.companyId, creator, id, "no", creator))!, /organiser/);
  assert.match((await respond(s.companyId, alice, id, "sure", alice))!, /Pick Yes, No or Maybe/);
  for (const status of ["pending_approval", "rejected", "cancelled"])
    assert.match((await respond(s.companyId, alice, await event(`status = '${status}'`), "yes", alice))!, /isn’t scheduled/);
  assert.match((await respond(s.companyId, alice, await event("status = 'sent', send_at = now() - interval '2 hours'"), "yes", alice))!, /ended/);
  // Started but still running: still open.
  assert.equal(await respond(s.companyId, alice, await event("status = 'sent', send_at = now() - interval '30 minutes'"), "yes", alice), null);
  assert.match((await respond(s.companyId, alice, await event("deleted_at = now()"), "yes", alice))!, /not found/);
  assert.equal((await q("select count(*)::int as n from event_responses where reminder_id = $1", [id]))[0].n, 0);
});

test("guests: organiser first as Yes, then everyone with their answer", async () => {
  const id = await event();
  await respond(s.companyId, bob, id, "no", bob);
  const g = await eventGuests(s.companyId, { id, createdBy: creator, creatorName: "Olga" });
  assert.deepEqual(g.list[0], { id: creator, name: "Olga", answer: "yes", organiser: true });
  assert.deepEqual(
    g.list.slice(1).map((x) => [x.id, x.answer]).sort(),
    [
      [alice, null],
      [bob, "no"],
    ].sort(),
  );
  assert.deepEqual(g.counts, { yes: 1, maybe: 0, no: 1, none: 1 });
  // Someone who left the department is no longer a guest, and their old answer isn't counted.
  await q("delete from department_members where user_id = $1", [bob]);
  assert.deepEqual((await eventGuests(s.companyId, { id, createdBy: creator, creatorName: "Olga" })).counts, { yes: 1, maybe: 0, no: 0, none: 1 });
  await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, bob]);
});

test("email link: the token answers for its guest only", async () => {
  const id = await event();
  const t = token(id, alice);
  assert.deepEqual(await rsvpTarget(t), { title: "Planning", when: (await rsvpTarget(t))!.when, location: null, answer: null, name: alice });
  assert.equal(await respondByToken(t, "no"), null);
  assert.equal((await rsvpTarget(t))!.answer, "no");
  assert.match((await respondByToken(`${t}x`, "yes"))!, /isn’t valid/);
  // A link made for a non-guest still can't answer.
  assert.match((await respondByToken(token(id, carol), "yes"))!, /not invited/);
});
