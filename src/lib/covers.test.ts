import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import type { CheckedFile } from "./attachments";
import { COMPANY_ADMIN_ROLE_ID, loadAccess } from "./permissions";
import { checkCover, COVER_MAX_BYTES, coverFile, coverUrl, createReminder, detachOccurrence, duplicateReminder, type ReminderInput, updateReminder } from "./reminders";
import { seeder } from "./test-helpers";

const s = seeder();
let alice: string;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const image = (name: string, sig: number[]) => {
  const c = checkCover(name, new Uint8Array([...sig, 1, 2, 3]));
  assert.ok("image" in c, JSON.stringify(c));
  return c.image as CheckedFile;
};
const actor = async () => ({ id: alice, access: await loadAccess(s.companyId, alice), email: "" });
// An hour ahead, so a live worker doesn't send it mid-test.
const task = (over: Partial<ReminderInput> = {}): ReminderInput => ({
  title: "Onboarding",
  description: "",
  links: [],
  senderName: "S",
  sendAt: new Date(Date.now() + 3_600_000),
  recurrence: null,
  anchorLocal: "2026-01-01T00:00",
  timeZone: "UTC",
  isTask: true,
  dueAfterMinutes: 120,
  channels: ["email"],
  tags: [],
  shares: [],
  targets: [{ kind: "user", ref: alice }],
  notifyBefore: [],
  ...over,
});
const typeOf = async (id: string) => (await coverFile(s.companyId, id))?.contentType ?? null;

before(async () => {
  await s.company();
  alice = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
});
after(async () => {
  await s.cleanup();
  await db.$client.end();
});

test("checkCover: raster images up to 5 MB, by their bytes", () => {
  assert.equal(image("a.png", PNG).contentType, "image/png");
  assert.equal(image("a.jpg", [0xff, 0xd8, 0xff]).contentType, "image/jpeg");
  const big = new Uint8Array(COVER_MAX_BYTES + 1);
  big.set(PNG);
  assert.match((checkCover("a.png", big) as { error: string }).error, /5 MB or smaller/);
  assert.match((checkCover("a.txt", new TextEncoder().encode("hi")) as { error: string }).error, /PNG, JPEG, GIF or WebP/);
  assert.match((checkCover("a.png", new Uint8Array([0xff, 0xd8, 0xff, 1])) as { error: string }).error, /doesn't match/);
});

test("create, keep, replace, remove; a task turned into a reminder drops it", async () => {
  const made = await createReminder(await actor(), s.companyId, task(), [], image("a.png", PNG));
  assert.ok("id" in made);
  assert.equal(await typeOf(made.id), "image/png");
  assert.match((await coverUrl(s.companyId, made.id))!, new RegExp(`^/api/cover/${made.id}\\?v=\\d+$`));

  assert.equal(await updateReminder(await actor(), s.companyId, made.id, task({ title: "Renamed" })), null);
  assert.equal(await typeOf(made.id), "image/png", "no change in the form keeps it");
  assert.equal(await updateReminder(await actor(), s.companyId, made.id, task(), [], [], image("b.jpg", [0xff, 0xd8, 0xff])), null);
  assert.equal(await typeOf(made.id), "image/jpeg", "replaced");
  assert.equal(await updateReminder(await actor(), s.companyId, made.id, task(), [], [], null), null);
  assert.equal(await typeOf(made.id), null, "removed");
  assert.equal(await coverUrl(s.companyId, made.id), null);

  await updateReminder(await actor(), s.companyId, made.id, task(), [], [], image("a.png", PNG));
  assert.equal(await updateReminder(await actor(), s.companyId, made.id, task({ isTask: false, dueAfterMinutes: null })), null);
  assert.equal(await typeOf(made.id), null, "a reminder has no cover");
  const plain = await createReminder(await actor(), s.companyId, task({ isTask: false, dueAfterMinutes: null }), [], image("a.png", PNG));
  assert.ok("id" in plain);
  assert.equal(await typeOf(plain.id), null);
});

test("a duplicate and a detached date keep the cover, unless removed in the form", async () => {
  const one = await createReminder(await actor(), s.companyId, task(), [], image("a.png", PNG));
  assert.ok("id" in one);
  const dup = await duplicateReminder(await actor(), s.companyId, one.id, new Date(Date.now() + 7_200_000));
  assert.ok("id" in dup);
  assert.equal(await typeOf(dup.id), "image/png");

  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const daily = { recurrence: { freq: "daily", interval: 1, end: { type: "never" } }, anchorLocal: `${day}T09:00`, sendAt: new Date(`${day}T09:00Z`) } as const;
  const series = await createReminder(await actor(), s.companyId, task(daily), [], image("a.png", PNG));
  assert.ok("id" in series, JSON.stringify(series));
  const kept = await detachOccurrence(await actor(), s.companyId, series.id, task({ title: "Just this one" }));
  assert.ok("id" in kept, JSON.stringify(kept));
  assert.equal(await typeOf(kept.id), "image/png");
  const dropped = await detachOccurrence(await actor(), s.companyId, series.id, task(), [], [], undefined, false, null);
  assert.ok("id" in dropped, JSON.stringify(dropped));
  assert.equal(await typeOf(dropped.id), null);
  assert.equal(await typeOf(series.id), "image/png", "the series keeps its own");
});
