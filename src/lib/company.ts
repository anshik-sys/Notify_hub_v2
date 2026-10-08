import { and, eq, isNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { companies, companyApprovers, roles, user, userRoles } from "@/db/schema";
import { COMPANY_ADMIN_ROLE_ID } from "./permissions";

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

// PRD 9.1: the sender name new reminders default to.
export const senderDefault = (c: { name: string; defaultSenderName: string | null }) => c.defaultSenderName || `Alerts | ${c.name}`;

export async function setDefaultSender(companyId: string, name: string) {
  const v = name.trim();
  if (v.length > 100) return "The sender name must be at most 100 characters.";
  await withTenant(companyId, (tx) => tx.update(companies).set({ defaultSenderName: v || null }).where(eq(companies.id, companyId)));
  return null;
}

export const RETENTION_CHOICES = [90, 180, 365, 730] as const;

// null = keep forever.
export async function setRetention(companyId: string, days: number | null) {
  if (days !== null && !(RETENTION_CHOICES as readonly number[]).includes(days)) return "Pick one of the listed periods.";
  await withTenant(companyId, (tx) => tx.update(companies).set({ retentionDays: days }).where(eq(companies.id, companyId)));
  return null;
}

export async function companySettings(companyId: string) {
  const [c] = await withTenant(companyId, (tx) =>
    tx
      .select({
        followUpTime: companies.followUpTime,
        defaultSenderName: companies.defaultSenderName,
        approvalMode: companies.approvalMode,
        retentionDays: companies.retentionDays,
      })
      .from(companies)
      .where(eq(companies.id, companyId)),
  );
  const named = await withTenant(companyId, (tx) => tx.select({ userId: companyApprovers.userId }).from(companyApprovers));
  return { ...c, approverIds: named.map((n) => n.userId) };
}

// People who may approve at all: active, with reminders.approve (or Company Admin).
export function eligibleApprovers(companyId: string) {
  return withTenant(companyId, (tx) =>
    tx
      .selectDistinct({ id: user.id, name: user.name, email: user.email })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(user, eq(user.id, userRoles.userId))
      .where(and(isNull(user.deactivatedAt), or(eq(roles.id, COMPANY_ADMIN_ROLE_ID), sql`'reminders.approve' = any(${roles.permissions})`)))
      .orderBy(user.name),
  );
}

// Named mode needs at least one eligible person; ineligible ids are dropped.
export async function setApprovers(companyId: string, mode: "any" | "named", userIds: string[]) {
  const eligible = new Set((await eligibleApprovers(companyId)).map((p) => p.id));
  const keep = [...new Set(userIds)].filter((id) => eligible.has(id));
  if (mode === "named" && !keep.length) return "Pick at least one approver.";
  await withTenant(companyId, async (tx) => {
    await tx.update(companies).set({ approvalMode: mode }).where(eq(companies.id, companyId));
    await tx.delete(companyApprovers);
    if (mode === "named") await tx.insert(companyApprovers).values(keep.map((userId) => ({ companyId, userId })));
  });
  return null;
}
