// Behaviour tests for docs/expected-behaviour.md section 3 (P1–P8), written
// from the spec, not the code.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { describeAgent } from "./account";
import { authDb } from "./auth";
import { type Access, COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { seeder } from "./test-helpers";
import { erasePerson, getUser, listUsers, personSessions, renamePerson, setActive, signOutPerson } from "./users";

const s = seeder();
const other = seeder();
type Actor = { id: string; access: Access };
let admin: Actor, boss: string, editor: Actor;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const actor = async (id: string) => ({ id, access: await loadAccess(s.companyId, id) });
const nameOf = async (id: string) => (await q(`select name from "user" where id = $1`, [id]))[0].name as string;
const sessionIds = async (id: string) => (await q("select id from session where user_id = $1 order by id", [id])).map((r) => r.id as string);
let n = 0;
const addSession = async (userId: string, opts: { ip?: string; ua?: string; created?: Date; updated?: Date } = {}) => {
  const id = `spec-s-${userId}-${n++}`;
  const token = `tok-${id}-secret`;
  await q(
    `insert into session (id, expires_at, token, user_id, created_at, updated_at, ip_address, user_agent)
     values ($1, now() + interval '1 day', $2, $3, $4, $5, $6, $7)`,
    [id, token, userId, opts.created ?? new Date(), opts.updated ?? new Date(), opts.ip ?? null, opts.ua ?? null],
  );
  return { id, token };
};
const member = async (name: string) => {
  const id = await s.user({ roles: [MEMBER_ROLE_ID] });
  await q(`update "user" set name = $2 where id = $1`, [id, name]);
  return id;
};

before(async () => {
  await s.company();
  await other.company();
  admin = await actor(await s.user({ roles: [COMPANY_ADMIN_ROLE_ID, MEMBER_ROLE_ID] }));
  boss = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  await q(`update "user" set name = 'The Boss' where id = $1`, [boss]);
  const [{ id: editors }] = await q("insert into roles (company_id, name, permissions) values ($1, 'People editors', '{users.edit}') returning id", [
    s.companyId,
  ]);
  editor = await actor(await s.user({ roles: [MEMBER_ROLE_ID, editors] }));
});
after(async () => {
  await other.cleanup();
  await s.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

test("P1: an editor of people renames a member; trimmed, shown in Team and on their page", async () => {
  const bob = await member("Bob Original");
  assert.equal(await renamePerson(editor, s.companyId, bob, "  Robert "), null);
  assert.equal(await nameOf(bob), "Robert");
  const team = (await listUsers(s.companyId)).users.find((u) => u.id === bob);
  assert.equal(team?.name, "Robert", "Team list shows the new name");
  assert.equal((await getUser(s.companyId, bob))?.name, "Robert", "their page shows the new name");
});

test("P2: empty, spaces-only or over-100-character names are refused; name unchanged", async () => {
  const pat = await member("Pat");
  for (const bad of ["", "   ", "x".repeat(101), ` ${"y".repeat(101)} `]) {
    const r = await renamePerson(editor, s.companyId, pat, bad);
    assert.equal(typeof r, "string", `refused: ${JSON.stringify(bad.slice(0, 10))}… (${bad.length} chars)`);
    assert.equal(await nameOf(pat), "Pat");
  }
  // The boundary itself is allowed.
  assert.equal(await renamePerson(editor, s.companyId, pat, "z".repeat(100)), null);
  assert.equal(await nameOf(pat), "z".repeat(100));
});

test("P3: a users.edit role can't rename a Company Admin; an admin can rename anyone", async () => {
  const r = await renamePerson(editor, s.companyId, boss, "Demoted");
  assert.match(r ?? "", /can't manage/);
  assert.equal(await nameOf(boss), "The Boss");

  // An admin renames another admin, an editor and a member.
  assert.equal(await renamePerson(admin, s.companyId, boss, "Big Boss"), null);
  assert.equal(await nameOf(boss), "Big Boss");
  assert.equal(await renamePerson(admin, s.companyId, editor.id, "Eddie"), null);
  assert.equal(await nameOf(editor.id), "Eddie");
  const m = await member("Mo");
  assert.equal(await renamePerson(admin, s.companyId, m, "Maureen"), null);
  assert.equal(await nameOf(m), "Maureen");
});

test("P4: renaming someone from another company is refused; their row unchanged", async () => {
  const stranger = await other.user({ roles: [MEMBER_ROLE_ID] });
  await other.owner.query(`update "user" set name = 'Stranger' where id = $1`, [stranger]);
  const before = (await other.owner.query(`select name, updated_at from "user" where id = $1`, [stranger])).rows[0];
  for (const who of [admin, editor]) {
    const r = await renamePerson(who, s.companyId, stranger, "Hijacked");
    assert.equal(typeof r, "string", "refused");
  }
  const afterRow = (await other.owner.query(`select name, updated_at from "user" where id = $1`, [stranger])).rows[0];
  assert.deepEqual(afterRow, before);
});

test("P5: renaming an erased person is refused", async () => {
  const gone = await member("To Erase");
  assert.equal(await setActive(admin, s.companyId, gone, false), null);
  assert.equal(await erasePerson(admin, s.companyId, gone), null);
  const erasedName = await nameOf(gone);
  for (const who of [admin, editor]) {
    const r = await renamePerson(who, s.companyId, gone, "Back Again");
    assert.equal(typeof r, "string", "refused");
  }
  assert.equal(await nameOf(gone), erasedName);
});

test("P6: sessions list device, IP, signed in, last active; never the token; null for someone above you", async () => {
  const sam = await member("Sam");
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  const created = new Date("2026-10-01T08:00:00Z");
  const updated = new Date("2026-10-18T17:30:00Z");
  const one = await addSession(sam, { ip: "203.0.113.7", ua, created, updated });
  const two = await addSession(sam, { ip: "198.51.100.9", ua: "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0" });
  await addSession(editor.id); // someone else's: not listed

  const list = await personSessions(editor, s.companyId, sam);
  assert.ok(list, "listed for a member");
  assert.equal(list.length, 2, "exactly sam's two sessions");
  const json = JSON.stringify(list);
  assert.ok(!json.includes(one.token) && !json.includes(two.token), "no session token in the result");
  for (const row of list) assert.ok(!("token" in row), "no token field");

  const values = (row: object) => Object.values(row);
  const rowOne = list.find((r) => values(r).includes("203.0.113.7"));
  assert.ok(rowOne, "IP shown");
  const strs = values(rowOne).filter((v): v is string => typeof v === "string");
  assert.ok(strs.includes(ua) || strs.includes(describeAgent(ua)), "device shown (user agent or its description)");
  const times = values(rowOne)
    .filter((v): v is Date => v instanceof Date)
    .map((d) => d.getTime());
  assert.ok(times.includes(created.getTime()), "signed-in time shown");
  assert.ok(times.includes(updated.getTime()), "last-active time shown");

  // Someone above you: null. A member (no admin role) for the admin above.
  assert.equal(await personSessions(editor, s.companyId, boss), null);
  // Another company's person can't be managed from here either.
  const stranger = await other.user();
  assert.equal(await personSessions(admin, s.companyId, stranger), null);
});

test("P7: sign out everywhere ends all their sessions and nobody else's; refused for yourself and someone above", async () => {
  const kim = await member("Kim");
  const lee = await member("Lee");
  await addSession(kim);
  await addSession(kim);
  await addSession(lee);
  await addSession(editor.id);
  await addSession(boss);
  const leeBefore = await sessionIds(lee);
  const editorBefore = await sessionIds(editor.id);
  const bossBefore = await sessionIds(boss);

  assert.equal(await signOutPerson(editor, s.companyId, kim), null);
  assert.deepEqual(await sessionIds(kim), [], "all of Kim's sessions end");
  assert.deepEqual(await sessionIds(lee), leeBefore, "Lee's survive");
  assert.deepEqual(await sessionIds(editor.id), editorBefore, "the actor's own survive");

  assert.equal(typeof (await signOutPerson(editor, s.companyId, editor.id)), "string", "refused for yourself");
  assert.deepEqual(await sessionIds(editor.id), editorBefore);

  assert.equal(typeof (await signOutPerson(editor, s.companyId, boss)), "string", "refused for someone above you");
  assert.deepEqual(await sessionIds(boss), bossBefore, "their sessions survive");
});

test.skip("P8: change your own email (browser only: Better Auth flow, email link, public route 404; checked 2026-10-19)", () => {});
