// Behaviour tests from docs/expected-behaviour.md section 11: "Changes and
// cancelling" (UP1–UP7). Written from the spec, not the code: a failure means
// one of them is wrong.
//
// Events are created and changed through the real web-side functions
// (createReminder, updateReminder, moveEntry, deleteEntry, cancelReminder,
// deleteReminder, decideReminder) as the organiser olga, in 2031. A "tick" runs
// what the worker runs each minute for events: dispatchChanges, then
// dispatchInvites. Every test uses fresh guests, so what a guest was sent is
// simply every delivery addressed to them.
//
// A live worker may be running against the same database: it can queue and
// send these notices before the test does. mailOf() then reads the sent email
// back from Mailpit instead of the fake `send`, and counts are "exactly one
// per guest per change", whoever queued it.
//
// Left for a manual check: Google, Outlook and Apple accepting the update or
// cancellation. Checked here: the .ics (same UID, a higher SEQUENCE,
// METHOD:REQUEST for an update, METHOD:CANCEL for a cancellation).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { checkFile } from "@/lib/attachments";
import { authDb } from "@/lib/auth";
import { respond } from "@/lib/events";
import type { sendMail } from "@/lib/mail";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "@/lib/permissions";
import {
  cancelReminder,
  createReminder,
  decideReminder,
  deleteEntry,
  deleteReminder,
  moveEntry,
  type RawReminder,
  type ReminderInput,
  setMyColor,
  updateReminder,
  validateInput,
} from "@/lib/reminders";
import { seeder } from "@/lib/test-helpers";
import { calendarRange } from "@/lib/views";
import { ownerDb } from "./db";
import { deliverOne, dispatchChanges, dispatchInvites } from "./delivery";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;

let admin: string, olga: string;
let ops: string, sales: string;
const emailOf = (id: string) => `${id}@${s.domain}`;
const at = (local: string) => new Date(`${local}:00Z`); // company zone is UTC
type Rule = NonNullable<ReminderInput["recurrence"]>;
const WEEKLY_MON: Rule = { freq: "weekly", interval: 1, weekdays: [0], end: { type: "never" } }; // 2031-03-03 is a Monday
const CHANGE_KINDS = ["update", "cancel", "uninvite"];

type Mail = Parameters<typeof sendMail>[0];
const capture = (box: Mail[]) => (async (m: Mail) => void box.push(m)) as unknown as typeof sendMail;
const actor = async (id: string) => ({ id, name: id, email: emailOf(id), access: await loadAccess(s.companyId, id) });

// Fresh members of Ops (olga's department: in her scope).
async function guests(n: number, dept = ops) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await s.user({ roles: [MEMBER_ROLE_ID] });
    await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, dept, id]);
    ids.push(id);
  }
  return ids;
}

// --- Event input, as the New / Edit form would send it -------------------------

type Ev = {
  title?: string;
  description?: string;
  start?: string; // local, UTC
  end?: string;
  location?: string;
  meetingUrl?: string;
  users?: string[];
  departments?: string[];
  recurrence?: Rule | null;
};
const NO_REPEAT = { repeat: "none", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" };
function evInput(e: Ev): ReminderInput {
  const start = e.start ?? "2031-03-03T09:00";
  const raw: RawReminder = {
    title: e.title ?? "Planning",
    description: e.description ?? "Bring numbers",
    senderName: "Olga",
    linkLabels: [],
    linkUrls: [],
    company: false,
    departmentIds: e.departments ?? [],
    groupIds: [],
    userIds: e.users ?? [],
    emails: "",
    when: "later",
    sendAtLocal: start,
    repeat: NO_REPEAT,
    isTask: false,
    dueLocal: "",
    channels: ["email"],
    slackChannelIds: [],
    tags: "",
    shareMine: false,
    shareDepartmentIds: [],
    shareGroupIds: [],
    shareCompany: false,
    isEvent: true,
    endLocal: e.end ?? start.replace(/T09:00$/, "T10:00"),
    allDay: false,
    location: e.location ?? "Room 2",
    meetingUrl: e.meetingUrl ?? "https://meet.example.com/abc-defg",
    notifyBefore: [],
  };
  const r = validateInput(raw, "UTC", "Olga");
  assert.ok("input" in r && r.input, `valid input: ${JSON.stringify(r)}`);
  return e.recurrence ? { ...r.input, recurrence: e.recurrence, anchorLocal: start } : r.input;
}
async function make(e: Ev) {
  const r = await createReminder(await actor(olga), s.companyId, evInput(e));
  assert.ok("id" in r, JSON.stringify(r));
  return r.id as string;
}
async function edit(id: string, e: Ev, files: Parameters<typeof updateReminder>[4] = []) {
  assert.equal(await updateReminder(await actor(olga), s.companyId, id, evInput(e), files), null);
}

// --- Worker side --------------------------------------------------------------

const tick = async () => {
  const ids: string[] = [];
  await dispatchChanges(async (x) => void ids.push(...x), s.companyId);
  await dispatchInvites(async (x) => void ids.push(...x), s.companyId);
  return ids;
};
type Row = { id: string; reminder_id: string; kind: string; channel: string; user_id: string; address: string; version: number | null; detail: string | null };
// Every invite / change notice addressed to these people (any event).
const sentTo = async (users: string[], kinds = ["invite", ...CHANGE_KINDS]): Promise<Row[]> =>
  (await q(
    "select id, reminder_id, kind, channel, user_id, address, version, detail from deliveries where user_id = any($1) and kind = any($2) order by created_at, id",
    [users, kinds],
  )) as Row[];
const ofEvent = async (id: string, kinds = CHANGE_KINDS): Promise<Row[]> =>
  (await q("select id, reminder_id, kind, channel, user_id, address, version, detail from deliveries where reminder_id = $1 and kind = any($2) order by created_at, id", [
    id,
    kinds,
  ])) as Row[];

// What the guest got for one delivery: subject, text and the .ics (unfolded).
type Got = { subject: string; text: string; ics: string | null };
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");
async function mailOf(deliveryId: string): Promise<Got> {
  const box: Mail[] = [];
  const r = await deliverOne(deliveryId, capture(box));
  if (r === "sent" && box.length) {
    const m = box[0];
    const att = (m.attachments ?? []).find((a) => /\.ics$/.test(a.filename));
    return { subject: m.subject, text: m.text, ics: att ? unfold(att.content.toString()) : null };
  }
  // The live worker sent (or is sending) it: wait, then read it from Mailpit.
  let d: { status: string; sent_at: Date | null; address: string } | undefined;
  for (let i = 0; i < 60; i++) {
    [d] = (await q("select status, sent_at, address from deliveries where id = $1", [deliveryId])) as (typeof d)[];
    if (d?.status === "sent" && d.sent_at) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  assert.ok(d?.status === "sent" && d.sent_at, `delivery ${deliveryId} was sent (deliverOne said ${r}, status ${d?.status})`);
  const base = process.env.MAILPIT_URL ?? "http://localhost:8025";
  let best: { ID: string; Created: string } | undefined;
  for (let i = 0; i < 20 && !best; i++) {
    const list = (await (await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:"${d.address}"`)}&limit=50`)).json()) as {
      messages: { ID: string; Created: string }[];
    };
    const sentAt = new Date(d.sent_at).getTime();
    best = list.messages.sort((a, b) => Math.abs(Date.parse(a.Created) - sentAt) - Math.abs(Date.parse(b.Created) - sentAt))[0];
    if (!best) await new Promise((res) => setTimeout(res, 250));
  }
  assert.ok(best, `the email for delivery ${deliveryId} is in Mailpit`);
  const msg = (await (await fetch(`${base}/api/v1/message/${best.ID}`)).json()) as {
    Subject: string;
    Text: string;
    Attachments: { PartID: string; FileName: string }[];
  };
  const part = msg.Attachments.find((a) => /\.ics$/.test(a.FileName));
  const ics = part ? unfold(await (await fetch(`${base}/api/v1/message/${best.ID}/part/${part.PartID}`)).text()) : null;
  return { subject: msg.Subject, text: msg.Text, ics };
}

const field = (ics: string, name: string) => new RegExp(`\\r\\n${name}(?:;[^:\\r]*)?:([^\\r]*)`).exec(ics)?.[1] ?? null;
const uidOf = (ics: string) => field(ics, "UID");
const seqOf = (ics: string) => Number(field(ics, "SEQUENCE") ?? 0);
const methodOf = (ics: string) => field(ics, "METHOD");

// Creates the event, runs a tick and delivers every invite; returns each
// guest's invite .ics by user id.
async function invited(id: string) {
  await tick();
  const rows = await ofEvent(id, ["invite"]);
  assert.ok(rows.length > 0, "invites queued");
  const out = new Map<string, string>();
  for (const r of rows) {
    const g = await mailOf(r.id);
    assert.ok(g.ics, "the invite has an .ics");
    out.set(r.user_id, g.ics);
  }
  return out;
}
const answers = async (id: string) => q("select user_id, answer from event_responses where reminder_id = $1 order by user_id", [id]);
const perGuest = (rows: Row[], kind: string) => {
  const m = new Map<string, Row[]>();
  for (const r of rows.filter((x) => x.kind === kind)) m.set(r.user_id, [...(m.get(r.user_id) ?? []), r]);
  return m;
};

before(async () => {
  await s.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  olga = await s.user({ roles: [MEMBER_ROLE_ID] });
  await q(`update "user" set name = 'Olga' where id = $1`, [olga]);
  [{ id: ops }] = await q("insert into departments (company_id, name) values ($1, $2) returning id", [s.companyId, `Ops-${randomUUID().slice(0, 6)}`]);
  [{ id: sales }] = await q("insert into departments (company_id, name) values ($1, $2) returning id", [s.companyId, `Sales-${randomUUID().slice(0, 6)}`]);
  await q("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, olga]);
});
after(async () => {
  await s.cleanup();
  await ownerDb.$client.end();
  await db.$client.end();
  await authDb.$client.end();
});

// --- Changes and cancelling ----------------------------------------------------

test("UP1: a time, place or link change (form, drag, Move to…) sends every guest one Updated with what changed and a next-version .ics; answers stay", async () => {
  const [alice, bob] = await guests(2);
  const ev: Ev = { title: "UP1 sync", users: [alice, bob], location: "Room 2", meetingUrl: "https://meet.example.com/abc-defg" };
  const id = await make(ev);
  const inv = await invited(id);
  assert.equal(await respond(s.companyId, alice, id, "yes", alice), null);
  assert.equal(await respond(s.companyId, bob, id, "maybe", bob), null);
  const before = await answers(id);
  const uid = uidOf(inv.get(alice)!);
  assert.ok(uid, "the invite .ics has a UID");
  let lastSeq = Math.max(...[...inv.values()].map(seqOf));

  // Checks one change: exactly one new Updated per guest, saying what changed.
  const seen = new Set<string>();
  async function expectUpdate(label: string, says: RegExp, ics: (x: string) => void) {
    await tick();
    await tick(); // a second run adds nothing
    const fresh = (await ofEvent(id)).filter((r) => !seen.has(r.id));
    for (const r of fresh) seen.add(r.id);
    assert.deepEqual(
      fresh.map((r) => [r.kind, r.user_id]).sort(),
      [
        ["update", alice],
        ["update", bob],
      ].sort(),
      `${label}: one Updated per guest: ${JSON.stringify(fresh)}`,
    );
    let seq = 0;
    for (const r of fresh) {
      assert.equal(r.address, emailOf(r.user_id), `${label}: addressed to the guest`);
      const g = await mailOf(r.id);
      assert.match(`${g.subject}\n${g.text}`, /updated/i, `${label}: says Updated: ${g.subject}`);
      assert.match(`${r.detail ?? ""}\n${g.text}`, says, `${label}: says what changed: ${r.detail} / ${g.text}`);
      assert.ok(g.ics, `${label}: a new .ics`);
      assert.equal(methodOf(g.ics), "REQUEST", `${label}: an update is METHOD:REQUEST`);
      assert.equal(uidOf(g.ics), uid, `${label}: same event (UID)`);
      assert.ok(seqOf(g.ics) > lastSeq, `${label}: next version: SEQUENCE ${seqOf(g.ics)} > ${lastSeq}`);
      seq = seqOf(g.ics);
      ics(g.ics);
    }
    lastSeq = seq;
    assert.deepEqual(await answers(id), before, `${label}: answers stay`);
  }

  // The form: a new place and a new link.
  await edit(id, { ...ev, location: "Room 9", meetingUrl: "https://meet.example.com/new-link" });
  await expectUpdate("form", /place|where|location|room 9|link|join/i, (ics) => {
    assert.match(ics, /\r\nLOCATION:Room 9\r\n/);
    assert.ok(ics.includes("https://meet.example.com/new-link"), "the new link is in the .ics");
  });

  // Drag (moveEntry): a new time, same length.
  const moved = await moveEntry(await actor(olga), s.companyId, id, at("2031-03-03T09:00"), at("2031-03-04T11:00"), "all");
  assert.ok(!("error" in moved), JSON.stringify(moved));
  await expectUpdate("drag", /time|when|date|moved|11[:.]00|4 Mar/i, (ics) => {
    assert.match(ics, /\r\nDTSTART:20310304T110000Z\r\n/);
    assert.match(ics, /\r\nDTEND:20310304T120000Z\r\n/);
  });

  // "Move to…" on the card (the same moveEntry, another time).
  const moved2 = await moveEntry(await actor(olga), s.companyId, id, at("2031-03-04T11:00"), at("2031-03-05T14:30"), "all");
  assert.ok(!("error" in moved2), JSON.stringify(moved2));
  await expectUpdate("move to", /time|when|date|moved|14[:.]30|5 Mar/i, (ics) => {
    assert.match(ics, /\r\nDTSTART:20310305T143000Z\r\n/);
    assert.match(ics, /\r\nDTEND:20310305T153000Z\r\n/);
  });
});

test("UP2: only the description, files or colour change: no update notice", async () => {
  const [alice] = await guests(1);
  const ev: Ev = { title: "UP2 quiet", users: [alice] };
  const id = await make(ev);
  await invited(id);
  const f = checkFile("agenda.txt", new TextEncoder().encode("1. numbers"));
  assert.ok("file" in f);
  await edit(id, { ...ev, description: "Bring numbers and charts" }, [f.file]);
  assert.equal(await setMyColor(await actor(olga), s.companyId, id, "grape"), null);
  await tick();
  await tick();
  assert.deepEqual(await ofEvent(id), [], "no update, cancel or uninvite");
  assert.equal((await ofEvent(id, ["invite"])).length, 1, "no second invite either");
});

test("UP3: a guest added later gets the invite", async () => {
  const [alice, newbie] = await guests(2);
  const ev: Ev = { title: "UP3 add", users: [alice] };
  const id = await make(ev);
  await invited(id);
  await edit(id, { ...ev, users: [alice, newbie] });
  await tick();
  await tick();
  const rows = await sentTo([newbie]);
  assert.deepEqual(
    rows.filter((r) => r.kind === "invite").map((r) => [r.reminder_id, r.user_id]),
    [[id, newbie]],
    `exactly one invite for the new guest: ${JSON.stringify(rows)}`,
  );
  const inv = rows.find((r) => r.kind === "invite")!;
  const g = await mailOf(inv.id);
  assert.match(`${g.subject}\n${g.text}`, /UP3 add/);
  assert.ok(g.ics, "with an .ics");
  assert.equal(methodOf(g.ics), "REQUEST");
});

test("UP4: a removed guest gets \"You're no longer invited\" with a cancelling .ics", async () => {
  const [alice, bob] = await guests(2);
  const ev: Ev = { title: "UP4 remove", users: [alice, bob] };
  const id = await make(ev);
  const inv = await invited(id);
  await edit(id, { ...ev, users: [alice] });
  await tick();
  await tick();
  const bobs = await sentTo([bob], CHANGE_KINDS);
  assert.deepEqual(bobs.map((r) => [r.reminder_id, r.kind]), [[id, "uninvite"]], `one notice for bob: ${JSON.stringify(bobs)}`);
  assert.deepEqual(await sentTo([alice], ["uninvite", "cancel"]), [], "alice is still invited");
  const g = await mailOf(bobs[0].id);
  assert.match(`${g.subject}\n${g.text}`, /no longer invited/i, g.subject);
  assert.ok(g.ics, "a cancelling .ics");
  assert.equal(methodOf(g.ics), "CANCEL");
  assert.equal(uidOf(g.ics), uidOf(inv.get(bob)!), "same event (UID)");
  assert.ok(seqOf(g.ics) > seqOf(inv.get(bob)!), `higher SEQUENCE: ${seqOf(g.ics)} > ${seqOf(inv.get(bob)!)}`);
});

test("UP5: cancelled or deleted: every guest gets Cancelled with a cancelling .ics; it leaves our calendars", async () => {
  for (const how of ["cancel", "delete"] as const) {
    const [alice, bob] = await guests(2);
    const id = await make({ title: `UP5 ${how}`, users: [alice, bob] });
    const inv = await invited(id);
    const shown = async (who: string) => {
      const r = await calendarRange(s.companyId, await actor(who), "UTC", { from: "2031-03-01", to: "2031-03-08" });
      assert.ok(r);
      return [...r.days.values()].flat().filter((e) => e.reminderId === id).length;
    };
    assert.equal(await shown(alice), 1, `${how}: on alice's calendar before`);
    const err = how === "cancel" ? await cancelReminder(await actor(olga), s.companyId, id) : await deleteReminder(await actor(olga), s.companyId, id);
    assert.equal(err, null);
    await tick();
    await tick();
    const rows = await sentTo([alice, bob], CHANGE_KINDS);
    assert.deepEqual(
      rows.map((r) => [r.kind, r.user_id]).sort(),
      [
        ["cancel", alice],
        ["cancel", bob],
      ].sort(),
      `${how}: one Cancelled per guest: ${JSON.stringify(rows)}`,
    );
    for (const r of rows) {
      const g = await mailOf(r.id);
      assert.match(`${g.subject}\n${g.text}`, /cancel/i, `${how}: says Cancelled: ${g.subject}`);
      assert.ok(g.ics, `${how}: a cancelling .ics`);
      assert.equal(methodOf(g.ics), "CANCEL", `${how}: METHOD:CANCEL`);
      assert.equal(uidOf(g.ics), uidOf(inv.get(r.user_id)!), `${how}: same UID`);
      assert.ok(seqOf(g.ics) > seqOf(inv.get(r.user_id)!), `${how}: higher SEQUENCE`);
    }
    assert.equal(await shown(alice), 0, `${how}: gone from alice's calendar`);
    assert.equal(await shown(bob), 0, `${how}: gone from bob's calendar`);
  }
});

// What a guest was sent after `since` (delivery ids already seen), with each .ics.
async function newFor(user: string, seen: Set<string>) {
  const rows = (await sentTo([user])).filter((r) => !seen.has(r.id));
  const out: (Row & Got)[] = [];
  for (const r of rows) out.push({ ...r, ...(await mailOf(r.id)) });
  return out;
}
const covers = (items: Got[], re: RegExp) => items.some((g) => g.ics && re.test(g.ics));

test("UP6: one date of a repeating event moved or deleted (this one / following / all): guests are told and the .ics covers it", async () => {
  const cases: { label: string; act: (id: string) => Promise<unknown>; check: (got: (Row & Got)[], uid: string) => void }[] = [
    {
      label: "move this one",
      act: async (id) => moveEntry(await actor(olga), s.companyId, id, at("2031-03-10T09:00"), at("2031-03-11T10:00"), "one"),
      check: (got, uid) => {
        // The 10 Mar 09:00 instance is gone from the series and 11 Mar 10:00 is there.
        assert.ok(
          got.some((g) => g.ics && uidOf(g.ics) === uid && /\r\nEXDATE[^\r]*20310310T090000Z?\r\n|\r\nEXDATE[^\r]*20310310T090000Z?,/.test(g.ics)) ||
            got.some((g) => g.ics && /\r\nRECURRENCE-ID[^\r]*20310310T090000Z?\r\n/.test(g.ics) && /\r\nDTSTART(;TZID=UTC)?:20310311T100000Z?\r\n/.test(g.ics)),
          "the .ics drops or overrides 10 Mar 09:00",
        );
        assert.ok(covers(got, /\r\nDTSTART(;TZID=UTC)?:20310311T100000Z?\r\n/), "an .ics has 11 Mar 10:00");
      },
    },
    {
      label: "move this and following",
      act: async (id) => moveEntry(await actor(olga), s.companyId, id, at("2031-03-17T09:00"), at("2031-03-17T11:00"), "following"),
      check: (got, uid) => {
        // The old series stops before 17 Mar; a series from 17 Mar 11:00 repeats.
        assert.ok(
          got.some((g) => {
            if (!g.ics || uidOf(g.ics) !== uid) return false;
            const until = /\r\nRRULE:[^\r]*UNTIL=(\d{8}(T\d{6}Z?)?)/.exec(g.ics)?.[1];
            const count = Number(/\r\nRRULE:[^\r]*COUNT=(\d+)/.exec(g.ics)?.[1] ?? 0);
            return (until !== undefined && until < "20310317T090000") || (count > 0 && count <= 2);
          }),
          "the series' .ics now ends before 17 Mar",
        );
        assert.ok(covers(got, /\r\nDTSTART(;TZID=UTC)?:20310317T110000Z?\r\n[\s\S]*\r\nRRULE:|\r\nRRULE:[\s\S]*\r\nDTSTART(;TZID=UTC)?:20310317T110000Z?\r\n/), "a repeating .ics from 17 Mar 11:00");
      },
    },
    {
      label: "move all",
      act: async (id) => moveEntry(await actor(olga), s.companyId, id, at("2031-03-10T09:00"), at("2031-03-10T13:00"), "all"),
      check: (got, uid) => {
        const g = got.find((x) => x.ics && uidOf(x.ics) === uid && methodOf(x.ics) === "REQUEST");
        assert.ok(g?.ics, "an update for the series");
        assert.match(g.ics, /\r\nDTSTART(;TZID=UTC)?:2031030\dT130000Z?\r\n/, "the series now at 13:00");
        assert.match(g.ics, /\r\nRRULE:FREQ=WEEKLY/, "still repeats");
      },
    },
    {
      label: "delete this one",
      act: async (id) => deleteEntry(await actor(olga), s.companyId, id, at("2031-03-10T09:00"), "one"),
      check: (got, uid) => {
        assert.ok(
          got.some((g) => g.ics && uidOf(g.ics) === uid && methodOf(g.ics) === "REQUEST" && /\r\nEXDATE[^\r]*20310310T090000Z?\r\n|\r\nEXDATE[^\r]*20310310T090000Z?,/.test(g.ics)) ||
            got.some((g) => g.ics && uidOf(g.ics) === uid && methodOf(g.ics) === "CANCEL" && /\r\nRECURRENCE-ID[^\r]*20310310T090000Z?\r\n/.test(g.ics)),
          "the .ics removes 10 Mar 09:00 (EXDATE, or a CANCEL for that RECURRENCE-ID)",
        );
      },
    },
    {
      label: "delete this and following",
      act: async (id) => deleteEntry(await actor(olga), s.companyId, id, at("2031-03-17T09:00"), "following"),
      check: (got, uid) => {
        assert.ok(
          got.some((g) => {
            if (!g.ics || uidOf(g.ics) !== uid) return false;
            const until = /\r\nRRULE:[^\r]*UNTIL=(\d{8}(T\d{6}Z?)?)/.exec(g.ics)?.[1];
            const count = Number(/\r\nRRULE:[^\r]*COUNT=(\d+)/.exec(g.ics)?.[1] ?? 0);
            const cut = (until !== undefined && until < "20310317T090000") || (count > 0 && count <= 2);
            const cancelRest = methodOf(g.ics) === "CANCEL" && /\r\nRECURRENCE-ID;[^\r]*RANGE=THISANDFUTURE[^\r]*:20310317T090000Z?\r\n/.test(g.ics);
            return cut || cancelRest;
          }),
          "the .ics ends the series before 17 Mar",
        );
      },
    },
  ];
  for (const c of cases) {
    const [alice, bob] = await guests(2);
    const id = await make({ title: `UP6 ${c.label}`, users: [alice, bob], start: "2031-03-03T09:00", end: "2031-03-03T09:30", recurrence: WEEKLY_MON });
    const inv = await invited(id);
    const uid = uidOf(inv.get(alice)!)!;
    const seen = new Set((await sentTo([alice, bob])).map((r) => r.id));
    const act = c.act;
    const r = await act(id).catch((e) => e);
    // moveEntry returns {id} or {error}; deleteEntry returns an error string or null.
    assert.ok(r === null || (typeof r === "object" && r && !("error" in r) && !(r instanceof Error)), `${c.label}: done: ${JSON.stringify(r)} ${r instanceof Error ? r.stack : ""}`);
    await tick();
    const afterOne = (await sentTo([alice, bob])).length;
    await tick();
    assert.equal((await sentTo([alice, bob])).length, afterOne, `${c.label}: a second run sends nothing more`);
    for (const g of [alice, bob]) {
      const got = await newFor(g, seen);
      assert.ok(got.length > 0, `${c.label}: the guest is told`);
      const byKind = perGuest(got, "update");
      for (const [, rows] of byKind)
        assert.equal(new Set(rows.map((x) => `${x.reminder_id}:${x.version}`)).size, rows.length, `${c.label}: no duplicate updates`);
      c.check(got, uid);
    }
  }
});

test("UP7: a change that widens the guests beyond what was approved needs approval again; nothing is sent until approved; in NotifyHub the change shows as needing approval", async () => {
  const [alice] = await guests(1);
  const [carol] = await guests(1, sales);
  const ev: Ev = { title: "UP7 widen", users: [alice], start: "2031-03-03T09:00", end: "2031-03-03T10:00", location: "Room 2" };
  const id = await make(ev);
  assert.equal((await q("select status from reminders where id = $1", [id]))[0].status, "scheduled", "in scope: scheduled");
  const inv = await invited(id);
  assert.equal(await respond(s.companyId, alice, id, "yes", alice), null);

  // Olga adds Sales (outside her scope) and moves it.
  await edit(id, { ...ev, departments: [sales], start: "2031-03-05T09:00", end: "2031-03-05T10:00", location: "Room 9" });
  assert.equal((await q("select status from reminders where id = $1", [id]))[0].status, "pending_approval", "needs approval again");
  await tick();
  await tick();
  assert.deepEqual(await sentTo([carol]), [], "nothing for the new guest yet");
  assert.deepEqual(await ofEvent(id), [], "no update or cancel to the old guests yet");
  // Guests' own calendars keep the old event because nothing was sent (above).
  // Inside NotifyHub the guest may see the change, marked as needing approval.
  const r = await calendarRange(s.companyId, await actor(alice), "UTC", { from: "2031-03-01", to: "2031-03-08" });
  assert.ok(r);
  const mine = [...r.days.values()].flat().filter((e) => e.reminderId === id);
  for (const e of mine) assert.equal(e.state, "pending", `shown to alice marked as needing approval: ${e.at.toISOString()} ${e.state}`);

  // Approved: carol is invited, alice gets one Updated.
  assert.equal(await decideReminder(await actor(admin), s.companyId, id, true), null);
  await tick();
  await tick();
  const carols = await sentTo([carol]);
  assert.deepEqual(carols.map((x) => [x.reminder_id, x.kind]), [[id, "invite"]], `carol invited once: ${JSON.stringify(carols)}`);
  const alices = await ofEvent(id);
  assert.deepEqual(alices.map((x) => [x.kind, x.user_id]), [["update", alice]], `one Updated to alice: ${JSON.stringify(alices)}`);
  const g = await mailOf(alices[0].id);
  assert.ok(g.ics);
  assert.match(g.ics, /\r\nDTSTART:20310305T090000Z\r\n/);
  assert.equal(uidOf(g.ics), uidOf(inv.get(alice)!));
  assert.ok(seqOf(g.ics) > seqOf(inv.get(alice)!));
  assert.deepEqual(await answers(id), [{ user_id: alice, answer: "yes" }], "alice's answer stays");
});
