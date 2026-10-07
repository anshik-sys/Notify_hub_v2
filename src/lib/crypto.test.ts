import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { decrypt, encrypt } from "./crypto";

test("round trip, fresh IV each time", () => {
  const a = encrypt("xoxb-secret");
  assert.notEqual(a, encrypt("xoxb-secret"));
  assert.equal(decrypt(a), "xoxb-secret");
});

test("tampering is detected", () => {
  const sealed = Buffer.from(encrypt("xoxb-secret"), "base64");
  sealed[sealed.length - 1] ^= 1;
  assert.throws(() => decrypt(sealed.toString("base64")));
});

test("refuses to load without a valid key", () => {
  const run = (key: string) =>
    execFileSync(process.execPath, ["--import", "tsx", "-e", 'import("./src/lib/crypto.ts")'], {
      env: { ...process.env, ENCRYPTION_KEY: key },
      stdio: "pipe",
    });
  assert.throws(() => run(""), /ENCRYPTION_KEY must be 32 bytes/);
  assert.throws(() => run(Buffer.alloc(16).toString("base64")), /ENCRYPTION_KEY must be 32 bytes/);
});
