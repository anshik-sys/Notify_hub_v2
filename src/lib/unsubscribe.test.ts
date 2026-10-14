import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { seeder } from "./test-helpers";
import { readUnsubscribe, unsubscribe, unsubscribeTarget, unsubscribeToken, unsubscribeUrls } from "./unsubscribe";

const s = seeder();
const other = seeder();
const rows = async (companyId: string) =>
  (await s.owner.query("select email from email_suppressions where company_id = $1", [companyId])).rows.map((r) => r.email);

before(async () => {
  await s.company();
  await other.company();
});
after(async () => {
  await s.cleanup();
  await other.cleanup();
  await db.$client.end();
});

test("a link unsubscribes exactly its address from exactly its company, once", async () => {
  const token = unsubscribeToken(s.companyId, "Ext@Else.test");
  assert.deepEqual(readUnsubscribe(token), { companyId: s.companyId, email: "ext@else.test" });
  assert.deepEqual(await unsubscribeTarget(token), { email: "ext@else.test", companyName: "Test Co" });

  assert.equal(await unsubscribe(token), null);
  assert.equal(await unsubscribe(token), null); // twice is fine
  assert.deepEqual(await rows(s.companyId), ["ext@else.test"]);
  assert.deepEqual(await rows(other.companyId), []);
});

test("forged, altered or foreign tokens do nothing", async () => {
  const token = unsubscribeToken(other.companyId, "a@else.test");
  const forged = `${Buffer.from(`${other.companyId}:victim@else.test`).toString("base64url")}.${token.split(".")[1]}`;
  assert.match((await unsubscribe(forged))!, /isn't valid/);
  assert.match((await unsubscribe("x".repeat(2000)))!, /isn't valid/);
  assert.equal(await unsubscribeTarget("garbage"), null);
  assert.deepEqual(await rows(other.companyId), []);
});

test("urls: a confirm page and a one-click endpoint", () => {
  const { page, oneClick } = unsubscribeUrls(s.companyId, "a@else.test");
  assert.match(page, /\/unsubscribe\/[\w-]+\.[\w-]+$/);
  assert.match(oneClick, /\/api\/unsubscribe\/[\w-]+\.[\w-]+$/);
});
