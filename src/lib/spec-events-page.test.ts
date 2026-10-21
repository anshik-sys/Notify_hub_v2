// Behaviour tests from docs/expected-behaviour.md section 12 (Finding events:
// an Events page): EP1–EP9 and EN1–EN4. Written from the spec, not the code:
// a failure means one of them is wrong. Approved answers to its open
// questions: "upcoming" includes a running event (shown as "Now"); your own
// waiting / rejected events are listed with a badge; admins see only their
// own events and their invitations.
//
// Events are seeded with raw SQL through the owner pool, dated 2031+, and
// myEvents / respond / dispatchInvites get a fixed `now` (NOW below). Events
// that have started by NOW are seeded 'sent', as the worker would leave them,
// so a live worker has nothing to do with them. Parts that are only visible in
// the browser (sidebar, buttons, Home section, labels) are noted per test.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "@/lib/auth";
import { ownerDb } from "@/worker/db";
import { dispatchInvites } from "@/worker/delivery";
import { EVENTS_PAGE, myEvents, respond } from "./events";
import { MUTABLE } from "./notifications";
import { can, COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { seeder } from "./test-helpers";
import { parseFilters, searchReminders } from "./views";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

const NOW = new Date("2031-06-01T12:00:00Z");
const at = (iso: string) => new Date(iso);
const WEEKLY_MON = { freq: "weekly", interval: 1, weekdays: [0], end: { type: "never" } };

let admin: string, olga: string, alice: string, bob: string, carol: string, nora: string, pat: string;
let ops: string;

let n = 0;
type EventOpts = {
  title?: string;
  status?: string;
  sendAt?: Date;
  duration?: number;
  location?: string | null;
  recurrence?: object | null;
  by?: string;
  sender?: string;
  deleted?: boolean;
  targets?: [string, string][];
};
async function event(o: EventOpts = {}) {
  const sendAt = o.sendAt ?? at("2031-07-01T09:00:00Z");
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status, time_zone, anchor_local,
       is_event, duration_minutes, location, channels, recurrence, deleted_at)
     values ($1, $2, $3, $4, '', $5, $6, $7, 'UTC', $8, true, $9, $10, '{email}', $11, ${o.deleted ? "now()" : "null"}) returning id`,
    [
      s.companyId,
      `EP-${s.companyId.slice(0, 6)}-${n++}`,
      o.by ?? olga,
      o.title ?? `Event ${n}`,
      o.sender ?? "Olga",
      sendAt,
      o.status ?? "scheduled",
      sendAt.toISOString().slice(0, 16),
      o.duration ?? 60,
      o.location === undefined ? "Room 2" : o.location,
      o.recurrence ? JSON.stringify(o.recurrence) : null,
    ],
  );
  for (const [kind, ref] of o.targets ?? [["user", alice]]) await q("insert into reminder_targets values ($1, $2, $3, $4)", [id, s.companyId, kind, ref]);
  return id as string;
}
async function plain(o: { title: string; task?: boolean }) {
  const [{ id }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, description, sender_name, send_at, status, time_zone, anchor_local, is_task, due_after_minutes, channels)
     values ($1, $2, $3, $4, '', 'Olga', '2031-07-01T09:00:00Z', 'scheduled', 'UTC', '2031-07-01T09:00', $5, $6, '{email}') returning id`,
    [s.companyId, `EP-${s.companyId.slice(0, 6)}-${n++}`, olga, o.title, !!o.task, o.task ? 60 : null],
  );
  await q("insert into reminder_targets values ($1, $2, 'user', $3)", [id, s.companyId, alice]);
  return id as string;
}

type Row = Awaited<ReturnType<typeof myEvents>>["rows"][number];
const upcoming = async (who: string, opts: { page?: number; limit?: number } = {}) => (await myEvents(s.companyId, who, { past: false, ...opts }, NOW)).rows;
const past = async (who: string, page?: number) => myEvents(s.companyId, who, { past: true, page }, NOW);
const ids = (rows: Row[]) => rows.map((r) => r.id);
const rowOf = (rows: Row[], id: string) => {
  const r = rows.find((x) => x.id === id);
  assert.ok(r, `row ${id} listed`);
  return r;
};

before(async () => {
  await s.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [olga, alice, bob, carol, pat] = [
    await s.user({ roles: [MEMBER_ROLE_ID] }),
    await s.user({ roles: [MEMBER_ROLE_ID] }),
    await s.user({ roles: [MEMBER_ROLE_ID] }),
    await s.user({ roles: [MEMBER_ROLE_ID] }),
    await s.user({ roles: [MEMBER_ROLE_ID] }),
  ];
  nora = await s.user(); // no roles, no permissions at all
  for (const [id, name] of [
    [admin, "Adam"],
    [olga, "Olga"],
    [alice, "Alice"],
    [bob, "Bob"],
    [carol, "Carol"],
    [nora, "Nora"],
    [pat, "Pat"],
  ])
    await q(`update "user" set name = $2 where id = $1`, [id, name]);
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, $2) returning id", [s.companyId, `Ops-${randomUUID().slice(0, 6)}`]);
  await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, bob]);
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
  await db.$client.end();
  await authDb.$client.end();
});

// --- The Events page ----------------------------------------------------------

test("EP1: a member with no permissions still gets the events they are invited to (sidebar item: browser check)", async () => {
  const access = await loadAccess(s.companyId, nora);
  assert.equal(can(access, "reminders.create"), false, "precondition: nora has no reminders.create");
  const id = await event({ title: "Nora invited", targets: [["user", nora]] });
  assert.deepEqual(ids(await upcoming(nora)), [id], "nora's Events page lists her invitation");
  // SKIP: the "Events" sidebar item for every member is only visible in the browser.
});

test("EP2: upcoming lists events I organise or am a guest of that have not ended, soonest first; a running one shows as now; a series is one row at its next date", async () => {
  const later = await event({ title: "Mine later", by: bob, sender: "Bob", sendAt: at("2031-08-10T09:00:00Z"), targets: [["user", carol]] });
  const viaDept = await event({ title: "Via department", sendAt: at("2031-06-05T09:00:00Z"), targets: [["department", ops]] });
  const series = await event({ title: "Weekly", sendAt: at("2031-06-09T10:00:00Z"), duration: 30, recurrence: WEEKLY_MON, targets: [["user", bob]] });
  const running = await event({ title: "Running", status: "sent", sendAt: at("2031-06-01T11:30:00Z"), duration: 60, targets: [["user", bob]] });
  const ended = await event({ title: "Ended", status: "sent", sendAt: at("2031-06-01T10:00:00Z"), duration: 60, targets: [["user", bob]] });
  const notMine = await event({ title: "Not mine", sendAt: at("2031-06-04T09:00:00Z"), targets: [["user", carol]] });
  const viaCompany = await event({ title: "Whole company", sendAt: at("2031-06-20T09:00:00Z"), targets: [["company", s.companyId]] });

  const rows = await upcoming(bob);
  const got = ids(rows);
  assert.deepEqual(got, [running, viaDept, series, viaCompany, later], "organised + invited (user, department, company), not ended, soonest first");
  assert.ok(!got.includes(ended), "an ended event is not upcoming");
  assert.ok(!got.includes(notMine), "an event I'm neither organiser nor guest of is not listed");
  assert.equal(rowOf(rows, running).now, true, "a running event is shown as now");
  assert.equal(rowOf(rows, viaDept).now, false, "a future event is not now");
  const sr = rowOf(rows, series);
  assert.equal(got.filter((x) => x === series).length, 1, "a series is one row");
  assert.equal(new Date(sr.sendAt).toISOString(), "2031-06-09T10:00:00.000Z", "the series row shows its next date");
  assert.ok(sr.recurrence, "the series row carries how it repeats");
  for (const id of [later, viaDept, series, running, ended, notMine, viaCompany]) await q("delete from reminders where id = $1", [id]);
});

test("EP3: past lists ended events, latest first, 25 per page", async () => {
  assert.equal(EVENTS_PAGE, 25);
  const made: string[] = [];
  // 27 ended events organised by pat, one hour apart (index 0 is the oldest).
  for (let i = 0; i < 27; i++)
    made.push(await event({ title: `Past ${i}`, by: pat, sender: "Pat", status: "sent", sendAt: new Date(at("2031-05-01T00:00:00Z").getTime() + i * 3_600_000), targets: [["user", carol]] }));
  const running = await event({ title: "Still running", by: pat, sender: "Pat", status: "sent", sendAt: at("2031-06-01T11:30:00Z"), targets: [["user", carol]] });
  const future = await event({ title: "Future", by: pat, sender: "Pat", sendAt: at("2031-07-01T09:00:00Z"), targets: [["user", carol]] });

  const p1 = await past(pat);
  assert.equal(p1.total, 27, "total counts only ended events");
  assert.deepEqual(ids(p1.rows), [...made].reverse().slice(0, 25), "page 1: latest first, 25");
  const p2 = await past(pat, 2);
  assert.deepEqual(ids(p2.rows), [made[1], made[0]], "page 2: the rest");
  assert.ok(!ids(p1.rows).includes(running) && !ids(p1.rows).includes(future), "running and future events are not past");
  // A guest sees them in Past too.
  assert.equal((await past(carol)).total >= 27, true, "a guest's past includes ended invitations");
  for (const id of [...made, running, future]) await q("delete from reminders where id = $1", [id]);
});

test("EP4: a row has title, when, where, organiser, my answer and the Going totals (organiser counted as Yes)", async () => {
  const id = await event({ title: "Planning", location: "Room 9", targets: [["user", alice], ["user", bob], ["user", carol]] });
  assert.equal(await respond(s.companyId, bob, id, "yes", bob, NOW), null);
  assert.equal(await respond(s.companyId, carol, id, "no", carol, NOW), null);
  assert.equal(await respond(s.companyId, alice, id, "maybe", alice, NOW), null);
  const r = rowOf(await upcoming(alice), id);
  assert.equal(r.title, "Planning");
  assert.equal(typeof r.when, "string");
  assert.ok(r.when.length > 0, "when is shown");
  assert.equal(r.location, "Room 9");
  assert.equal(r.organiser, "Olga");
  assert.equal(r.answer, "maybe", "my answer");
  assert.deepEqual(r.going, { yes: 2, maybe: 1, no: 1 }, "organiser + bob yes, alice maybe, carol no");
  // The organiser's own row shows the same totals.
  assert.deepEqual(rowOf(await upcoming(olga), id).going, { yes: 2, maybe: 1, no: 1 });
  // SKIP: the title linking to the event and the row's layout are a browser check.
  await q("delete from reminders where id = $1", [id]);
});

test("EP5: a guest of an upcoming event can answer from the row (same rules as RS1 / RS3); not once it has ended", async () => {
  const id = await event({ title: "Answerable", targets: [["user", alice]] });
  let r = rowOf(await upcoming(alice), id);
  assert.equal(r.open, true, "a guest of an upcoming event can answer");
  assert.equal(r.organising, false);
  assert.equal(r.answer, null, "no answer yet");
  assert.equal(await respond(s.companyId, alice, id, "yes", alice, NOW), null);
  r = rowOf(await upcoming(alice), id);
  assert.equal(r.answer, "yes", "the current answer is shown");
  assert.equal(await respond(s.companyId, alice, id, "no", alice, NOW), null, "can change it");
  assert.equal(rowOf(await upcoming(alice), id).answer, "no");
  // RS3: someone who isn't a guest is refused.
  assert.equal(typeof (await respond(s.companyId, carol, id, "yes", carol, NOW)), "string", "a non-guest is refused");

  // A running event: still open until it ends.
  const running = await event({ title: "Running answerable", status: "sent", sendAt: at("2031-06-01T11:30:00Z"), targets: [["user", alice]] });
  assert.equal(rowOf(await upcoming(alice), running).open, true, "can answer until the event ends");
  // An ended event: past, not open, and respond refuses.
  const ended = await event({ title: "Ended answerable", status: "sent", sendAt: at("2031-06-01T09:00:00Z"), targets: [["user", alice]] });
  assert.equal(rowOf((await past(alice)).rows, ended).open, false, "an ended event can't be answered");
  assert.equal(typeof (await respond(s.companyId, alice, ended, "yes", alice, NOW)), "string", "answering an ended event is refused");
  // SKIP: the Yes / Maybe / No buttons, the filled current one and staying on the tab are a browser check.
  for (const x of [id, running, ended]) await q("delete from reminders where id = $1", [x]);
});

test("EP6: as the organiser the row says Organiser (organising), not answer buttons", async () => {
  const id = await event({ title: "Mine", targets: [["user", alice]] });
  const r = rowOf(await upcoming(olga), id);
  assert.equal(r.organising, true, "the organiser's row is marked organising");
  assert.equal(rowOf(await upcoming(alice), id).organising, false, "a guest's row is not");
  // SKIP: the "Organiser" label in place of the buttons is a browser check.
  await q("delete from reminders where id = $1", [id]);
});

test("EP7: my own event waiting for approval or rejected is listed for me with its status; guests don't see it", async () => {
  const waiting = await event({ title: "Waiting", status: "pending_approval", targets: [["user", alice]] });
  const rejected = await event({ title: "Rejected", status: "rejected", targets: [["user", alice]] });
  const rows = await upcoming(olga);
  assert.equal(rowOf(rows, waiting).status, "pending_approval", "listed with its status (Needs approval badge)");
  assert.equal(rowOf(rows, rejected).status, "rejected", "listed with its status (Not approved badge)");
  const guest = ids(await upcoming(alice));
  assert.ok(!guest.includes(waiting), "a guest doesn't see an event waiting for approval");
  assert.ok(!guest.includes(rejected), "a guest doesn't see a rejected event");
  const guestPast = ids((await past(alice)).rows);
  assert.ok(!guestPast.includes(waiting) && !guestPast.includes(rejected), "nor in Past");
  // SKIP: the badge wording is a browser check.
  for (const x of [waiting, rejected]) await q("delete from reminders where id = $1", [x]);
});

test("EP8: cancelled or deleted events are not listed, upcoming or past", async () => {
  const cancelled = await event({ title: "Cancelled", status: "cancelled", targets: [["user", alice]] });
  const deleted = await event({ title: "Deleted", status: "cancelled", deleted: true, targets: [["user", alice]] });
  const deletedSent = await event({ title: "Deleted ended", status: "sent", deleted: true, sendAt: at("2031-05-20T09:00:00Z"), targets: [["user", alice]] });
  const cancelledPast = await event({ title: "Cancelled ended", status: "cancelled", sendAt: at("2031-05-20T09:00:00Z"), targets: [["user", alice]] });
  for (const who of [olga, alice]) {
    const all = [...ids(await upcoming(who)), ...ids((await past(who)).rows)];
    for (const [name, id] of [
      ["cancelled", cancelled],
      ["deleted", deleted],
      ["deleted (ended)", deletedSent],
      ["cancelled (ended)", cancelledPast],
    ])
      assert.ok(!all.includes(id), `${name} not listed for ${who === olga ? "the organiser" : "a guest"}`);
  }
  for (const x of [cancelled, deleted, deletedSent, cancelledPast]) await q("delete from reminders where id = $1", [x]);
});

test("EP9: an admin sees only their own events and their invitations here", async () => {
  const others = await event({ title: "Olga to Alice", targets: [["user", alice]] });
  const own = await event({ title: "Admin's own", by: admin, sender: "Adam", targets: [["user", alice]] });
  const invited = await event({ title: "Admin invited", targets: [["user", admin]] });
  const got = ids(await upcoming(admin));
  assert.ok(got.includes(own), "own event listed");
  assert.ok(got.includes(invited), "invitation listed");
  assert.ok(!got.includes(others), "an event the admin could open but neither organises nor is invited to is not listed");
  for (const x of [others, own, invited]) await q("delete from reminders where id = $1", [x]);
});

// --- Elsewhere ------------------------------------------------------------------

const inviteNotes = async (id: string) =>
  q("select user_id, reminder_id, text, actor_id from notifications where reminder_id = $1 and kind = 'invite' order by user_id", [id]);
const dispatch = (now = NOW) => dispatchInvites(async () => {}, s.companyId, now);

test("EN1: an invite creates one in-app notification per guest per event, linking to it, always on", async () => {
  const before0 = new Date("2031-01-01T00:00:00Z");
  const id = await event({ title: "Planning", sendAt: at("2031-07-01T09:00:00Z"), targets: [["user", alice], ["department", ops]] });
  const series = await event({ title: "Standup", sendAt: at("2031-07-07T09:00:00Z"), recurrence: WEEKLY_MON, targets: [["user", alice]] });
  const waiting = await event({ title: "Waiting", status: "pending_approval", targets: [["user", alice]] });
  await dispatch(before0);
  await dispatch(before0); // a second run creates nothing new

  const notes = await inviteNotes(id);
  assert.deepEqual(notes.map((x) => x.user_id).sort(), [alice, bob].sort(), "one per guest, none for the organiser");
  for (const x of notes) {
    assert.equal(x.reminder_id, id, "links to the event");
    assert.match(x.text, /Olga invited you to Planning/);
  }
  assert.equal((await inviteNotes(series)).length, 1, "a repeating event: once for the series");
  assert.equal((await inviteNotes(waiting)).length, 0, "no invite, no notification, while waiting for approval");

  // IN6: someone joining the guest department later gets theirs once.
  await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, carol]);
  await dispatch(before0);
  await dispatch(before0);
  assert.deepEqual((await inviteNotes(id)).map((x) => x.user_id).sort(), [alice, bob, carol].sort(), "the joiner gets one, others no second");
  await q("delete from department_members where user_id = $1", [carol]);

  // Always on: invites are not a mutable kind.
  assert.ok(!MUTABLE.some((m) => (m.event as string) === "invite"), "invite is not in MUTABLE");
  for (const x of [id, series, waiting]) await q("delete from reminders where id = $1", [x]);
});

test("EN2: Home's Upcoming events: my next 5 (organiser or guest) with my answer (the section itself: browser check)", async () => {
  const made: string[] = [];
  for (let i = 0; i < 7; i++)
    made.push(
      await event({
        title: `Home ${i}`,
        by: i % 2 ? carol : olga,
        sender: i % 2 ? "Carol" : "Olga",
        sendAt: new Date(at("2031-06-02T09:00:00Z").getTime() + (6 - i) * 86_400_000), // made[6] is soonest
        targets: [["user", i % 2 ? olga : alice]],
      }),
    );
  // olga organises 0,2,4,6 and is a guest of 1,3,5.
  assert.equal(await respond(s.companyId, olga, made[5], "maybe", olga, NOW), null);
  const rows = await upcoming(olga, { limit: 5 });
  assert.deepEqual(ids(rows), [made[6], made[5], made[4], made[3], made[2]], "the next 5, soonest first, organiser or guest");
  assert.equal(rowOf(rows, made[5]).answer, "maybe", "with my answer");
  // SKIP: the Home section and its "All events" link are a browser check.
  for (const x of made) await q("delete from reminders where id = $1", [x]);
});

test("EN3: the Reminders Type filter has Event; Reminder no longer includes events", async () => {
  const ev = await event({ title: "zzEN3 event", targets: [["user", alice]] });
  const rem = await plain({ title: "zzEN3 reminder" });
  const task = await plain({ title: "zzEN3 task", task: true });
  const viewer = { id: admin, access: await loadAccess(s.companyId, admin) };
  const search = async (type?: string) =>
    (await searchReminders(s.companyId, viewer, "UTC", parseFilters({ q: "zzEN3", ...(type ? { type } : {}) }))).rows.map((r) => (r as { id: string }).id).sort();
  assert.deepEqual(await search(), [ev, rem, task].sort(), "no type: all three");
  assert.deepEqual(await search("event"), [ev], "Event: only events");
  assert.deepEqual(await search("reminder"), [rem], "Reminder: no events, no tasks");
  assert.deepEqual(await search("task"), [task], "Task: only tasks");
  assert.equal(parseFilters({ type: "event" }).type, "event");
  // SKIP: the filter's "Event" option in the form is a browser check.
  for (const x of [ev, rem, task]) await q("delete from reminders where id = $1", [x]);
});

test("EN4: the event page's buttons say Edit event / Cancel event / Delete event (and series)", { skip: "UI labels only: a browser check" }, () => {});
