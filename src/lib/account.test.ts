import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { describeAgent, hasPassword, isValidTimeZone, listMySessions, revokeMySession, setTimeZone } from "./account";
import { authDb } from "./auth";
import { needsTwoFactorSetup } from "./session";
import { seeder } from "./test-helpers";

const s = seeder();
let alice: string, bob: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const addSession = (id: string, userId: string) =>
  q("insert into session (id, expires_at, token, user_id, updated_at) values ($1, now() + interval '1 day', $1, $2, now())", [id, userId]);

before(async () => {
  await s.company();
  [alice, bob] = [await s.user(), await s.user()];
});
after(async () => {
  await s.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

test("sessions: list and revoke only my own", async () => {
  await addSession(`a1-${alice}`, alice);
  await addSession(`a2-${alice}`, alice);
  await addSession(`b1-${bob}`, bob);
  assert.deepEqual((await listMySessions(alice)).map((x) => x.id).sort(), [`a1-${alice}`, `a2-${alice}`].sort());
  assert.match((await revokeMySession(alice, `b1-${bob}`))!, /isn't yours/);
  assert.equal((await q("select 1 from session where id = $1", [`b1-${bob}`])).length, 1);
  assert.equal(await revokeMySession(alice, `a1-${alice}`), null);
  assert.deepEqual((await listMySessions(alice)).map((x) => x.id), [`a2-${alice}`]);
});

test("time zone, password, device names", async () => {
  assert.ok(isValidTimeZone("Asia/Dubai"));
  assert.ok(!isValidTimeZone("Mars/Base"));
  assert.match((await setTimeZone(alice, "Mars/Base"))!, /Pick a time zone/);
  assert.equal(await setTimeZone(alice, "Asia/Dubai"), null);
  assert.equal((await q(`select time_zone from "user" where id = $1`, [alice]))[0].time_zone, "Asia/Dubai");
  assert.equal(await setTimeZone(alice, null), null);
  assert.equal((await q(`select time_zone from "user" where id = $1`, [alice]))[0].time_zone, null);

  assert.equal(await hasPassword(alice), false);
  await q("insert into account (id, account_id, provider_id, user_id, password, updated_at) values ($1, $2, 'credential', $2, 'x', now())", [`acc-${alice}`, alice]);
  assert.equal(await hasPassword(alice), true);

  assert.equal(describeAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"), "Chrome on macOS");
  assert.equal(describeAgent(null), "Unknown device");
});

test("require 2FA gate", () => {
  assert.equal(needsTwoFactorSetup({ requireTwoFactor: true }, { twoFactorEnabled: false }), true);
  assert.equal(needsTwoFactorSetup({ requireTwoFactor: true }, { twoFactorEnabled: true }), false);
  assert.equal(needsTwoFactorSetup({ requireTwoFactor: false }, { twoFactorEnabled: null }), false);
});

test("reset tokens are stored hashed (PRD 11.1)", async () => {
  const { auth } = await import("./auth");
  let link = "";
  // Capture the token from the email instead of sending it.
  const opts = (auth as unknown as { options: { emailAndPassword: { sendResetPassword: (d: { url: string }) => Promise<void> } } }).options;
  const original = opts.emailAndPassword.sendResetPassword;
  opts.emailAndPassword.sendResetPassword = async ({ url }) => void (link = url);
  try {
    await q("insert into account (id, account_id, provider_id, user_id, password, updated_at) values ($1, $2, 'credential', $2, 'x', now()) on conflict do nothing", [`acc2-${bob}`, bob]);
    await auth.api.requestPasswordReset({ body: { email: `${bob}@${s.domain}`, redirectTo: "/reset-password" } });
  } finally {
    opts.emailAndPassword.sendResetPassword = original;
  }
  const token = new URL(link).pathname.split("/").pop()!;
  assert.ok(token.length > 10);
  const rows = await q("select identifier from verification where value = $1", [bob]);
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].identifier.includes(token)); // only a hash is kept
  await q("delete from verification where value = $1", [bob]);
});
