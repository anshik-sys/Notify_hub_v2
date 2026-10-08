import assert from "node:assert/strict";
import { test } from "node:test";
import { problems } from "./env-check";

const good = {
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "https://notify.example.com",
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  DATABASE_URL: "postgres://a",
  AUTH_DATABASE_URL: "postgres://b",
  OWNER_DATABASE_URL: "postgres://c",
  SMTP_URL: "smtp://x",
  MAIL_FROM: "a@b.c",
  SLACK_CLIENT_ID: "1",
  SLACK_CLIENT_SECRET: "2",
  SLACK_SIGNING_SECRET: "3",
};
const role = { superuser: false, bypassRls: false };

test("a good production config passes", () => assert.deepEqual(problems(good, role), []));

test("each unsafe setting is named", () => {
  const p = problems(
    { ...good, BETTER_AUTH_URL: "http://notify.example.com", BETTER_AUTH_SECRET: "short", ENCRYPTION_KEY: "abc", SMTP_URL: undefined, SLACK_API_URL: "http://fake", SLACK_SIGNING_SECRET: undefined },
    { superuser: true, bypassRls: false },
  ).join("\n");
  for (const m of [/https/, /BETTER_AUTH_SECRET/, /ENCRYPTION_KEY/, /SMTP_URL is not set/, /superuser/, /SLACK_API_URL/, /SLACK_SIGNING_SECRET/]) assert.match(p, m);
});

test("localhost may use http and the fake Slack", () => {
  assert.deepEqual(problems({ ...good, BETTER_AUTH_URL: "http://localhost:3000", SLACK_API_URL: "http://localhost:4999/api" }, role), []);
  assert.match(problems(good, { superuser: false, bypassRls: true }).join(), /BYPASSRLS/);
});

test("platform owners need an IP allowlist outside localhost", () => {
  assert.match(problems({ ...good, PLATFORM_OWNER_EMAILS: "o@x.test" }, role).join(), /PLATFORM_ALLOWED_IPS/);
  assert.deepEqual(problems({ ...good, PLATFORM_OWNER_EMAILS: "o@x.test", PLATFORM_ALLOWED_IPS: "203.0.113.5" }, role), []);
});
