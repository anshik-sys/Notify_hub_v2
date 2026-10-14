import { and, desc, eq, inArray } from "drizzle-orm";
import { companies, emailSuppressions } from "@/db/schema";
import { readToken, signToken } from "./crypto";
import { isUuid } from "./validate";

// PRD 7.1: outside recipients can unsubscribe from one company's reminders.
// The link carries a signed company id + address, so no lookup or login is
// needed, and nobody can unsubscribe an address they weren't sent.
const PURPOSE = "unsubscribe";

export const unsubscribeToken = (companyId: string, email: string) => signToken(PURPOSE, `${companyId}:${email.toLowerCase()}`);

// The page (confirm first, so mail scanners following links don't unsubscribe
// people) and the one-click URL for the List-Unsubscribe header (RFC 8058).
export const unsubscribeUrls = (companyId: string, email: string) => {
  const t = unsubscribeToken(companyId, email);
  return { page: `${process.env.BETTER_AUTH_URL}/unsubscribe/${t}`, oneClick: `${process.env.BETTER_AUTH_URL}/api/unsubscribe/${t}` };
};

export function readUnsubscribe(token: string) {
  const data = token.length <= 1000 ? readToken(PURPOSE, token) : null;
  const i = data?.indexOf(":") ?? -1;
  const [companyId, email] = i > 0 ? [data!.slice(0, i), data!.slice(i + 1)] : [];
  return companyId && email && isUuid(companyId) ? { companyId, email } : null;
}

// Web only. Idempotent: unsubscribing twice is fine. Returns an error string
// or null. @/db is imported here, not at the top, because the worker imports
// this file for the URLs and must never load the web app's DB client.
export async function unsubscribe(token: string) {
  const who = readUnsubscribe(token);
  if (!who) return "This unsubscribe link isn't valid.";
  const { withTenant } = await import("@/db");
  await withTenant(who.companyId, (tx) => tx.insert(emailSuppressions).values(who).onConflictDoNothing());
  return null;
}

// For the confirm page: whose reminders, and which address. Web only.
export async function unsubscribeTarget(token: string) {
  const who = readUnsubscribe(token);
  if (!who) return null;
  const { withTenant } = await import("@/db");
  const [c] = await withTenant(who.companyId, (tx) => tx.select({ name: companies.name }).from(companies));
  return c ? { email: who.email, companyName: c.name } : null;
}

// The person's own undo, from the same link. Only they can re-subscribe:
// a company re-adding someone who opted out is what anti-spam rules forbid.
export async function resubscribe(token: string) {
  const who = readUnsubscribe(token);
  if (!who) return "This link isn't valid.";
  const { withTenant } = await import("@/db");
  await withTenant(who.companyId, (tx) => tx.delete(emailSuppressions).where(and(eq(emailSuppressions.companyId, who.companyId), eq(emailSuppressions.email, who.email))));
  return null;
}

// Settings → Unsubscribed (admins). Newest first.
export async function listUnsubscribed(companyId: string) {
  const { withTenant } = await import("@/db");
  return withTenant(companyId, (tx) =>
    tx.select({ email: emailSuppressions.email, createdAt: emailSuppressions.createdAt }).from(emailSuppressions).orderBy(desc(emailSuppressions.createdAt)),
  );
}

// Which of these addresses unsubscribed from the company (lowercased).
export async function unsubscribedAmong(companyId: string, emails: string[]) {
  const wanted = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (!wanted.length) return [];
  const { withTenant } = await import("@/db");
  const rows = await withTenant(companyId, (tx) =>
    tx.select({ email: emailSuppressions.email }).from(emailSuppressions).where(inArray(emailSuppressions.email, wanted)),
  );
  return rows.map((r) => r.email);
}
