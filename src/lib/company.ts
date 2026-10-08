import { eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { companies } from "@/db/schema";

// HH:MM, 24-hour, in the company's time zone (also a DB CHECK).
export async function setFollowUpTime(companyId: string, time: string) {
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) return "Pick a time of day.";
  await withTenant(companyId, (tx) => tx.update(companies).set({ followUpTime: time }).where(eq(companies.id, companyId)));
  return null;
}

export async function followUpTime(companyId: string) {
  const [c] = await withTenant(companyId, (tx) =>
    tx.select({ followUpTime: companies.followUpTime }).from(companies).where(eq(companies.id, companyId)),
  );
  return c.followUpTime;
}

// PRD 9.1. Turning it on needs the admin's own 2FA first, so they can't lock
// themselves out of the settings they just changed.
export async function setRequireTwoFactor(companyId: string, on: boolean, actorHasTwoFactor: boolean) {
  if (on && !actorHasTwoFactor) return "Set up two-factor for yourself first (Settings → Security).";
  await withTenant(companyId, (tx) => tx.update(companies).set({ requireTwoFactor: on }).where(eq(companies.id, companyId)));
  return null;
}
