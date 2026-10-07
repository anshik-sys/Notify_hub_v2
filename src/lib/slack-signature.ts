import { createHmac, timingSafeEqual } from "node:crypto";

// Slack request signing: v0=hex(HMAC-SHA256(secret, "v0:{ts}:{rawBody}")),
// and a timestamp within 5 minutes (replays of old captured requests fail).
// Must run on the raw body, before any parsing.
export function verifySlackSignature(rawBody: string, ts: string | null, signature: string | null, secret: string, now = Date.now()) {
  if (!ts || !signature || !secret || !/^\d+$/.test(ts)) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex")}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
