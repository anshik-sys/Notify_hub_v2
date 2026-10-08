import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "./auth";
import { addComment, deleteComment, editComment, listComments } from "./comments";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { setMutes } from "./notifications";
import { seeder } from "./test-helpers";

const s = seeder();
const other = seeder();
let admin: string, alice: string, bob: string, carol: string, creator: string, reminderId: string, otherReminder: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const name = (id: string) => `N-${id.slice(0, 6)}`;
const actor = async (id: string) => ({ id, name: name(id), email: `${id}@${s.domain}`, access: await loadAccess(s.companyId, id) });
const mails: string[] = [];
const send = (async (m: { to: string }) => void mails.push(m.to)) as never;

before(async () => {
  await s.company();
  await other.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [creator, alice, bob, carol] = [await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] })];
  for (const u of [admin, creator, alice, bob, carol]) await q(`update "user" set name = $2 where id = $1`, [u, name(u)]);
  const mk = async (title: string) =>
    (
      await q(
        `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local)
         values ($1, $2, $3, $4, 'S', now(), 'sent', 'UTC', '2026-01-01T00:00') returning id`,
        [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, creator, title],
      )
    )[0].id as string;
  [reminderId, otherReminder] = [await mk("Quarterly review"), await mk("Other")];
  // Alice and Bob received it; Carol didn't.
  const [{ id: occ }] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now(), 'sent') returning id", [
    s.companyId,
    reminderId,
  ]);
  for (const u of [alice, bob])
    await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id, status) values ($1, $2, $3, $4, $4, 'sent')", [
      s.companyId,
      reminderId,
      occ,
      u,
    ]);
});
after(async () => {
  await q("delete from comments where company_id = $1", [s.companyId]);
  await s.cleanup();
  await other.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

test("who can comment; replies flatten to one level", async () => {
  assert.match(((await addComment(await actor(carol), s.companyId, reminderId, { body: "hi", mentionIds: [] })) as { error: string }).error, /not found/);
  assert.match(((await addComment(await actor(alice), s.companyId, reminderId, { body: "  ", mentionIds: [] })) as { error: string }).error, /Write something/);

  const top = await addComment(await actor(alice), s.companyId, reminderId, { body: "First", mentionIds: [] }, { send });
  assert.ok("id" in top);
  const reply = await addComment(await actor(bob), s.companyId, reminderId, { body: "Reply", parentId: top.id, mentionIds: [] }, { send });
  assert.ok("id" in reply);
  const nested = await addComment(await actor(alice), s.companyId, reminderId, { body: "Reply to reply", parentId: reply.id, mentionIds: [] }, { send });
  assert.ok("id" in nested);
  const thread = await listComments(s.companyId, reminderId);
  assert.deepEqual(thread.map((c) => [c.body, c.replies.map((r) => r.body)]), [["First", ["Reply", "Reply to reply"]]]);

  // A parent from another reminder is refused.
  const elsewhere = await addComment(await actor(creator), s.companyId, otherReminder, { body: "x", mentionIds: [] }, { send });
  assert.ok("id" in elsewhere);
  assert.match(
    ((await addComment(await actor(alice), s.companyId, reminderId, { body: "x", parentId: elsewhere.id, mentionIds: [] })) as { error: string }).error,
    /isn't on this reminder/,
  );
  // Another company sees nothing.
  assert.deepEqual(await listComments(other.companyId, reminderId), []);
});

test("mentions: cleaned, and only people who can see the reminder are notified", async () => {
  mails.length = 0;
  const stranger = await other.user();
  const r = await addComment(
    await actor(alice),
    s.companyId,
    reminderId,
    {
      body: `@${name(bob)} and @${name(carol)} and @${name(creator)} and @${name(alice)} please check`,
      // bob/creator: can see; carol: can't; alice: herself; stranger: other company; admin: not in the text
      mentionIds: [bob, carol, creator, alice, stranger, admin],
    },
    { send },
  );
  assert.ok("id" in r);
  assert.deepEqual(r.skipped, [name(carol)]);
  assert.deepEqual(mails.sort(), [`${bob}@${s.domain}`, `${creator}@${s.domain}`].sort());
  const saved = (await q("select user_id from comment_mentions where comment_id = $1", [r.id])).map((m) => m.user_id).sort();
  assert.deepEqual(saved, [alice, bob, carol, creator].sort()); // stranger and admin (not in text) dropped

  // Editing notifies only the newly mentioned.
  mails.length = 0;
  const e = await editComment(await actor(alice), s.companyId, r.id, { body: `@${name(bob)} and @${name(admin)}`, mentionIds: [bob, admin] }, { send });
  assert.ok("id" in e);
  assert.deepEqual(mails, [`${admin}@${s.domain}`]);
  const thread = await listComments(s.companyId, reminderId);
  const edited = thread.find((c) => c.id === r.id)!;
  assert.equal(edited.edited, true);
  assert.deepEqual(edited.mentions.sort(), [name(admin), name(bob)].sort());
});

test("edit and delete permissions; soft delete keeps replies", async () => {
  const top = await addComment(await actor(alice), s.companyId, reminderId, { body: "Mine", mentionIds: [] }, { send });
  assert.ok("id" in top);
  const reply = await addComment(await actor(bob), s.companyId, reminderId, { body: "Bob's reply", parentId: top.id, mentionIds: [] }, { send });
  assert.ok("id" in reply);

  assert.match(((await editComment(await actor(bob), s.companyId, top.id, { body: "hijack", mentionIds: [] })) as { error: string }).error, /own comments/);
  assert.match(((await deleteComment(await actor(bob), s.companyId, top.id)) as { error: string }).error, /own comments/);
  assert.ok("reminderId" in (await deleteComment(await actor(admin), s.companyId, reply.id))); // moderator
  assert.ok("reminderId" in (await deleteComment(await actor(alice), s.companyId, top.id))); // author

  const t = (await listComments(s.companyId, reminderId)).find((c) => c.id === top.id)!;
  assert.deepEqual([t.deleted, t.body, t.replies.length, t.replies[0].deleted], [true, "", 1, true]);
  assert.match(((await editComment(await actor(alice), s.companyId, top.id, { body: "back", mentionIds: [] })) as { error: string }).error, /own comments/);
  assert.match(
    ((await addComment(await actor(bob), s.companyId, reminderId, { body: "x", parentId: top.id, mentionIds: [] })) as { error: string }).error,
    /was deleted/,
  );
});

test("notifications: mentions in-app (email unless muted); the creator hears about new comments", async () => {
  await q("delete from notifications where company_id = $1", [s.companyId]);
  mails.length = 0;
  await setMutes(s.companyId, bob, ["mention:email"]);
  const kinds = async (userId: string) => (await q("select kind from notifications where user_id = $1 order by created_at", [userId])).map((x) => x.kind);
  const c = await addComment(await actor(alice), s.companyId, reminderId, { body: `@${name(bob)} look`, mentionIds: [bob] }, { send });
  assert.ok("id" in c);
  assert.deepEqual(await kinds(bob), ["mention"]);
  assert.deepEqual(mails, []); // bob muted mention emails
  assert.deepEqual(await kinds(creator), ["comment"]);
  // Mentioning the creator: one "mention", no extra "comment".
  await addComment(await actor(alice), s.companyId, reminderId, { body: `@${name(creator)} ok?`, mentionIds: [creator] }, { send });
  assert.deepEqual(await kinds(creator), ["comment", "mention"]);
  // The creator's own comment notifies nobody.
  await addComment(await actor(creator), s.companyId, reminderId, { body: "noted", mentionIds: [] }, { send });
  assert.deepEqual(await kinds(creator), ["comment", "mention"]);
  await setMutes(s.companyId, bob, []);
});

test("sharing lets people see and comment; mentioning them notifies", async () => {
  const outsider = await s.user({ roles: [MEMBER_ROLE_ID] });
  await q(`update "user" set name = $2 where id = $1`, [outsider, name(outsider)]);
  assert.match(((await addComment(await actor(outsider), s.companyId, reminderId, { body: "hi", mentionIds: [] })) as { error: string }).error, /not found/);
  await q("insert into reminder_shares (reminder_id, company_id, kind) values ($1, $2, 'company')", [reminderId, s.companyId]);
  assert.ok("id" in (await addComment(await actor(outsider), s.companyId, reminderId, { body: "Now I can", mentionIds: [] }, { send })));
  mails.length = 0;
  const m = await addComment(await actor(alice), s.companyId, reminderId, { body: `@${name(carol)} see this`, mentionIds: [carol] }, { send });
  assert.ok("id" in m);
  assert.deepEqual(m.skipped, []); // carol can see it now, through the share
  assert.deepEqual(mails, [`${carol}@${s.domain}`]);
  await q("delete from reminder_shares where reminder_id = $1", [reminderId]);
});
