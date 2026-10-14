import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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

// Signed (not secret) tokens for links in emails, e.g. unsubscribe. The
// purpose is part of the MAC, so a token for one use is useless for another.
// Output: base64url(data).base64url(hmac).
const mac = (purpose: string, data: string) =>
  createHmac("sha256", key).update(`${purpose}\0${data}`).digest("base64url");

export const signToken = (purpose: string, data: string) => `${Buffer.from(data).toString("base64url")}.${mac(purpose, data)}`;

// The signed data, or null if the token was altered or made for another purpose.
export function readToken(purpose: string, token: string) {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const data = Buffer.from(body, "base64url").toString("utf8");
  const want = Buffer.from(mac(purpose, data));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? data : null;
}
