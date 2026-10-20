import { and, eq, isNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { companies, companyApprovers, companyLogos, roles, user, userRoles } from "@/db/schema";
import { checkFile } from "./attachments";
import { COMPANY_ADMIN_ROLE_ID } from "./permissions";
import { deleteLogo, getLogo, putLogo } from "./storage";
import { isTimeZone } from "./time";

// Both optional ("" clears). Shared with the platform console.
export function checkContact(email: string, phone: string) {
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return "Enter a valid contact email.";
  const digits = phone.replace(/\D/g, "").length;
  if (phone && (!/^\+?[\d\s()-]+$/.test(phone) || digits < 7 || digits > 15)) return "Enter a valid contact phone, like +971 4 123 4567.";
  return null;
}

export async function setContact(companyId: string, email: string, phone: string) {
  email = email.trim().toLowerCase();
  phone = phone.trim();
  const error = checkContact(email, phone);
  if (error) return error;
  await withTenant(companyId, (tx) =>
    tx.update(companies).set({ contactEmail: email || null, contactPhone: phone || null }).where(eq(companies.id, companyId)),
  );
  return null;
}

// PRD 9.1: admins edit their company's name and time zone. The domain stays
// with the platform owner: invites and sign-in are tied to it.
export async function setProfile(companyId: string, name: string, timeZone: string) {
  name = name.trim();
  if (!name || name.length > 100) return "Company name must be 1–100 characters.";
  if (!isTimeZone(timeZone)) return "Choose a valid time zone.";
  await withTenant(companyId, (tx) => tx.update(companies).set({ name, timeZone }).where(eq(companies.id, companyId)));
  return null;
}

// PRD 4 branding. Raster images only (no SVG: it can carry scripts), checked
// by their bytes, small enough for an email header.
export const LOGO_MAX_BYTES = 256 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// A raster image checked by its bytes (logo, profile photo), or an error.
export function checkImage(fileName: string, bytes: Uint8Array, maxBytes: number, what: string) {
  if (bytes.length > maxBytes) return { error: `The ${what} must be ${maxBytes / 1024 >= 1024 ? `${maxBytes / 1024 / 1024} MB` : `${maxBytes / 1024} KB`} or smaller.` };
  const checked = checkFile(fileName, bytes);
  if ("error" in checked) return checked;
  if (!IMAGE_TYPES.includes(checked.file.contentType)) return { error: "Use a PNG, JPEG, GIF or WebP image." };
  return { image: checked.file };
}

export async function setLogo(companyId: string, fileName: string, bytes: Uint8Array) {
  const checked = checkImage(fileName, bytes, LOGO_MAX_BYTES, "logo");
  if ("error" in checked) return checked.error;
  await withTenant(companyId, (tx) => putLogo(tx, companyId, checked.image.contentType, checked.image.data));
  return null;
}

export const removeLogo = (companyId: string) => withTenant(companyId, (tx) => deleteLogo(tx, companyId));

// For /api/logo/<company id>. Public on purpose: mail clients load it.
export const logoFile = (companyId: string) => withTenant(companyId, (tx) => getLogo(tx, companyId));

// Name and logo version for the shell and emails. `logoVersion` changes when
// the logo does, so URLs carrying it bust caches; null = no logo.
export async function companyBrand(companyId: string) {
  const [row] = await withTenant(companyId, (tx) =>
    tx
      .select({ name: companies.name, logoAt: companyLogos.updatedAt })
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id))
      .where(eq(companies.id, companyId)),
  );
  return { name: row?.name ?? "", logoVersion: row?.logoAt ? String(row.logoAt.getTime()) : null };
}

// HH:MM, 24-hour, in the company's time zone (also a DB CHECK).
export async function setFollowUpTime(companyId: string, time: string) {
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) return "Pick a time of day.";
  await withTenant(companyId, (tx) => tx.update(companies).set({ followUpTime: time }).where(eq(companies.id, companyId)));
  return null;
}

// PRD 5.8: days past due before managers are told; blank turns it off.
export async function setEscalateAfterDays(companyId: string, raw: string) {
  const v = raw.trim();
  const days = v === "" ? null : Number(v);
  if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 60)) return "Escalate after 1 to 60 days, or leave it blank.";
  await withTenant(companyId, (tx) => tx.update(companies).set({ escalateAfterDays: days }).where(eq(companies.id, companyId)));
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
        domain: companies.domain,
        contactEmail: companies.contactEmail,
        contactPhone: companies.contactPhone,
        followUpTime: companies.followUpTime,
        escalateAfterDays: companies.escalateAfterDays,
        defaultSenderName: companies.defaultSenderName,
        approvalMode: companies.approvalMode,
        retentionDays: companies.retentionDays,
        dailyEmailLimit: companies.dailyEmailLimit,
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
