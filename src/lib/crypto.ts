import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Integration secrets at rest (PRD 11.1): AES-256-GCM with ENCRYPTION_KEY
// (32 random bytes, base64). Loading this module without a valid key throws,
// so any process that handles tokens refuses to start without it.
// Output: base64(iv[12] | tag[16] | ciphertext).
const raw = process.env.ENCRYPTION_KEY ?? "";
const key = Buffer.from(raw, "base64");
if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 (openssl rand -base64 32)");

export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

// Throws if the value was tampered with or encrypted under another key.
export function decrypt(sealed: string) {
  const buf = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
