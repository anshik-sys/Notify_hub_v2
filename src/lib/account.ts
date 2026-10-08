import { and, desc, eq } from "drizzle-orm";
import QRCode from "qrcode";
import { account, session, twoFactor, user } from "@/db/schema";
import { authDb } from "./auth";

// The signed-in person's own account (PRD 3.3, 8 "Settings"). Sessions,
// accounts and 2FA rows are auth tables the app role can't read, so this goes
// through authDb, and every query is filtered by the person's own id.

export const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz.length <= 64;
  } catch {
    return false;
  }
};

export const TIME_ZONES = Intl.supportedValuesOf("timeZone");

// null clears it (back to the company's zone).
export async function setTimeZone(userId: string, tz: string | null) {
  if (tz !== null && !isValidTimeZone(tz)) return "Pick a time zone from the list.";
  await authDb.update(user).set({ timeZone: tz }).where(eq(user.id, userId));
  return null;
}

// Google-only people have no password to change.
export async function hasPassword(userId: string) {
  const [row] = await authDb
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .limit(1);
  return Boolean(row);
}

export async function listMySessions(userId: string) {
  return authDb
    .select({ id: session.id, token: session.token, ipAddress: session.ipAddress, userAgent: session.userAgent, createdAt: session.createdAt, updatedAt: session.updatedAt })
    .from(session)
    .where(eq(session.userId, userId))
    .orderBy(desc(session.updatedAt));
}

// Only one of my own; returns an error or null.
export async function revokeMySession(userId: string, sessionId: string) {
  const deleted = await authDb
    .delete(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId)))
    .returning({ id: session.id });
  return deleted.length ? null : "That session isn't yours or has already ended.";
}

// "Chrome on macOS", good enough to recognise a device.
export function describeAgent(ua: string | null) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl\//.test(ua) ? "curl" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

// The authenticator QR, rendered for this response only (never stored).
export const totpQrSvg = (uri: string) => QRCode.toString(uri, { type: "svg", margin: 1, width: 192 });

// An admin's reset (PRD 9.1): 2FA off and every session ended. The caller has
// checked permission and that the actor may manage this person.
export async function resetTwoFactor(userId: string) {
  await authDb.transaction(async (tx) => {
    await tx.delete(twoFactor).where(eq(twoFactor.userId, userId));
    await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, userId));
    await tx.delete(session).where(eq(session.userId, userId));
  });
}
