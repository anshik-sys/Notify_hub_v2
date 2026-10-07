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
