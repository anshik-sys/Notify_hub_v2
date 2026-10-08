import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { clientIp, limit, limits } from "./rate-limit";

const prefix = `test:${randomUUID()}`;
after(async () => {
  await db.$client.query("delete from rate_limits where key like $1", [`${prefix}%`]);
  await db.$client.end();
});

test("counts up, refuses, resets after the window; keys independent", async () => {
  const k = `${prefix}:a`;
  for (let i = 1; i <= 3; i++) assert.equal((await limit(k, 3, 60)).ok, true);
  const r = await limit(k, 3, 60);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.retryAfter > 0 && r.retryAfter <= 60);
  assert.equal((await limit(`${prefix}:b`, 3, 60)).ok, true);
  await db.$client.query("update rate_limits set window_start = now() - interval '61 seconds' where key = $1", [k]);
  assert.equal((await limit(k, 3, 60)).ok, true); // new window
  assert.match((await limits([[`${prefix}:c`, 0, 600]]))!, /Too many attempts\. Try again in 10 minutes/);
});

test("fails closed when the store is unavailable", async () => {
  const broken = async () => {
    throw new Error("connection refused");
  };
  const r = await limit(`${prefix}:x`, 100, 60, broken);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && "unavailable" in r);
});

test("client ip: first hop of the configured header", () => {
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
  assert.equal(clientIp(new Headers()), "unknown");
});
