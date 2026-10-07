import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifySlackSignature } from "./slack-signature";

const secret = "s3cret";
const now = 1_800_000_000_000;
const ts = String(now / 1000);
const sign = (body: string, t = ts, key = secret) => `v0=${createHmac("sha256", key).update(`v0:${t}:${body}`).digest("hex")}`;

test("verifySlackSignature", () => {
  const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
  assert.equal(verifySlackSignature(body, ts, sign(body), secret, now), true);
  assert.equal(verifySlackSignature(body + "x", ts, sign(body), secret, now), false); // tampered body
  assert.equal(verifySlackSignature(body, ts, sign(body, ts, "other"), secret, now), false); // wrong secret
  const old = String(now / 1000 - 301);
  assert.equal(verifySlackSignature(body, old, sign(body, old), secret, now), false); // stale (replay)
  assert.equal(verifySlackSignature(body, ts, "v0=abc", secret, now), false); // malformed
  assert.equal(verifySlackSignature(body, null, sign(body), secret, now), false);
  assert.equal(verifySlackSignature(body, ts, sign(body), "", now), false); // no secret configured
});
