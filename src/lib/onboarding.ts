import { and, eq, isNull } from "drizzle-orm";
import { authDb } from "./auth";
import { companies, user } from "@/db/schema";

// ponytail: short list, swap for a maintained free-mail list when self-signup opens publicly
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com"]);

export function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Creates the company and attaches the signed-in user to it, atomically.
// Returns an error message, or null on success.
export async function createCompany(userId: string, email: string, name: string, timeZone: string) {
  name = name.trim();
  if (!name || name.length > 100) return "Company name must be 1–100 characters.";
  if (!isTimeZone(timeZone)) return "Choose a valid time zone.";
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return "Your email has no domain.";
  if (FREE_MAIL.has(domain)) return `Sign up with your work email, not ${domain}.`;

  try {
    await authDb.transaction(async (tx) => {
      const [company] = await tx.insert(companies).values({ name, domain, timeZone }).returning({ id: companies.id });
      const updated = await tx
        .update(user)
        .set({ companyId: company.id })
        .where(and(eq(user.id, userId), isNull(user.companyId)))
        .returning({ id: user.id });
      if (updated.length === 0) throw new Error("already onboarded");
    });
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") return `A company for ${domain} already exists. Ask its admin for an invite.`;
    if ((e as Error).message === "already onboarded") return "You already belong to a company.";
    throw e;
  }
  return null;
}
