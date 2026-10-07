import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db, withTenant } from "@/db";
import { notifications } from "@/db/schema";
import {
  addNotifications,
  getMutes,
  listNotifications,
  markAllRead,
  markReadForReminder,
  mutedFor,
  openNotification,
  setMutes,
  unreadCount,
} from "./notifications";
import { seeder } from "./test-helpers";

const s = seeder();
const other = seeder();
let alice: string, bob: string, r1: string, r2: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const add = (userId: string, reminderId: string, text: string, dedupeKey?: string) =>
  withTenant(s.companyId, (tx) => addNotifications(tx, [{ companyId: s.companyId, userId, kind: "reminder", reminderId, text, dedupeKey }]));

before(async () => {
  await s.company();
  await other.company();
  [alice, bob] = [await s.user(), await s.user()];
  const mk = async (title: string) =>
    (
      await q(
        `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local)
         values ($1, $2, $3, $4, 'S', now(), 'sent', 'UTC', '2026-01-01T00:00') returning id`,
        [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, alice, title],
      )
    )[0].id as string;
  [r1, r2] = [await mk("One"), await mk("Two")];
});
after(async () => {
  await s.cleanup();
  await other.cleanup();
  await db.$client.end();
});

test("list, unread, open, mark read; only my own", async () => {
  await add(alice, r1, "a1");
  await add(alice, r2, "a2", "k");
  await add(alice, r2, "a2 again", "k"); // same dedupe key: ignored
  await add(bob, r1, "b1");

  const mine = await listNotifications(s.companyId, alice);
  assert.deepEqual(mine.items.map((n) => [n.text, n.reminderTitle]).sort(), [["a1", "One"], ["a2", "Two"]]);
  assert.equal(await unreadCount(s.companyId, alice), 2);

  // Bob can't open Alice's; Alice opening one lands on its reminder.
  const a1 = mine.items.find((n) => n.text === "a1")!;
  assert.equal(await openNotification(s.companyId, bob, a1.id), null);
  assert.equal(await unreadCount(s.companyId, alice), 2);
  assert.equal(await openNotification(s.companyId, alice, a1.id), `/reminders/${r1}`);
  assert.equal(await unreadCount(s.companyId, alice), 1);

  await markReadForReminder(s.companyId, alice, r2);
  assert.equal(await unreadCount(s.companyId, alice), 0);
  assert.equal(await unreadCount(s.companyId, bob), 1); // untouched
  await add(alice, r1, "a3");
  await markAllRead(s.companyId, bob);
  assert.deepEqual([await unreadCount(s.companyId, alice), await unreadCount(s.companyId, bob)], [1, 0]);

  // Another company sees none of it, and can't write into this one.
  assert.equal((await withTenant(other.companyId, (tx) => tx.select().from(notifications))).length, 0);
  await assert.rejects(
    withTenant(other.companyId, (tx) => tx.insert(notifications).values({ companyId: s.companyId, userId: alice, kind: "reminder", text: "x" })),
  );
});

test("mutes: unticked channels, unknown keys ignored", async () => {
  await setMutes(s.companyId, alice, ["mention:email", "approval:email", "bogus:email", "mention:sms"]);
  assert.deepEqual([...(await getMutes(s.companyId, alice))].sort(), ["approval:email", "mention:email"]);
  const muted = await withTenant(s.companyId, (tx) => mutedFor(tx, [alice, bob], "mention"));
  assert.deepEqual([...muted], [`${alice}:email`]);
  await setMutes(s.companyId, alice, []);
  assert.equal((await getMutes(s.companyId, alice)).size, 0);
});
