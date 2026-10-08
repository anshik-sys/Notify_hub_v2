import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db, setCurrentActor, withTenant } from "@/db";
import { companies, platformSettings } from "@/db/schema";
import { auth, authDb } from "./auth";
import { createInvitation } from "./invitations";
import { isTimeZone } from "./onboarding";
import { ALL_PERMISSIONS, COMPANY_ADMIN_ROLE_ID, isPermission } from "./permissions";
import { clientIp, limits } from "./rate-limit";

// The platform-owner console (PRD 9.2). Owners are the accounts listed in
// PLATFORM_OWNER_EMAILS, with 2FA on, coming from PLATFORM_ALLOWED_IPS
// (decided with the user). Anything else gets a 404: the console isn't
// advertised. Cross-company reads go through SECURITY DEFINER functions
// (migration 0027) that only run with app.platform = 'on', set here.
// Never call platform_* functions from anywhere else.

const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
type Env = Record<string, string | undefined>;
export const isOwnerEmail = (email: string, env: Env = process.env) => list(env.PLATFORM_OWNER_EMAILS).includes(email.toLowerCase());

// Exact addresses (v4 or v6) or IPv4 CIDR. No list: localhost only outside
// production (env-check refuses to start production without one).
export function ipAllowed(ip: string, env: Env = process.env) {
  const allowed = list(env.PLATFORM_ALLOWED_IPS);
  const addr = ip.replace(/^::ffff:/, "");
  if (!allowed.length) return env.NODE_ENV !== "production" && ["127.0.0.1", "::1", "unknown"].includes(addr);
  return allowed.some((rule) => {
    if (!rule.includes("/")) return rule === addr;
    const [base, bits] = rule.split("/");
    const toInt = (a: string) => a.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr) || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (toInt(addr) & mask) === (toInt(base) & mask);
  });
}

export type Owner = { id: string; name: string; email: string };

// "ok", or why not. A missing 2FA is the one reason worth telling the owner.
export async function platformAccess(): Promise<{ owner: Owner } | { reason: "no" | "2fa" }> {
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session || session.user.deactivatedAt || !isOwnerEmail(session.user.email) || !ipAllowed(clientIp(h))) return { reason: "no" };
  if (!session.user.twoFactorEnabled) return { reason: "2fa" };
  return { owner: { id: session.user.id, name: session.user.name, email: session.user.email } };
}

// For pages and actions: 404 unless a fully qualified owner. Writes made
// with withTenant afterwards are audited under the owner.
export async function requirePlatformOwner() {
  const a = await platformAccess();
  if (!("owner" in a)) notFound();
  await setCurrentActor(a.owner.id);
  return a.owner;
}

// Actions also get a rate limit; returns an error message or null.
export async function ownerAction() {
  const owner = await requirePlatformOwner();
  const limited = await limits([[`platform:${owner.id}`, 60, 60]]);
  return { owner, limited };
}

function platformTx<T>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.platform', 'on', true)`);
    return fn(tx);
  });
}

type Rows<T> = { rows: T[] };
export type CompanyRow = {
  id: string;
  name: string;
  domain: string;
  time_zone: string;
  created_at: Date;
  suspended_at: Date | null;
  people: number;
  admins: string | null;
  scheduled: number;
  sent_24h: number;
  failed_24h: number;
  sent_30d: number;
  failed_30d: number;
  last_activity: Date | null;
};

// Raw execute() returns timestamps as strings; make them Dates.
const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));
export const platformCompanies = () =>
  platformTx(async (tx) =>
    ((await tx.execute(sql`select * from platform_companies()`)) as unknown as Rows<CompanyRow>).rows.map((r) => ({
      ...r,
      created_at: date(r.created_at)!,
      suspended_at: date(r.suspended_at),
      last_activity: date(r.last_activity),
    })),
  );

export const platformQueue = () =>
  platformTx(
    async (tx) =>
      (
        (await tx.execute(sql`select * from platform_queue()`)) as unknown as Rows<{
          queued: number;
          sending: number;
          failed_24h: number;
          oldest_queued_seconds: number | null;
          overdue_reminders: number;
          worker_seconds: number | null;
        }>
      ).rows[0],
  );

const DOMAIN = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

// A new company plus an invitation for its first admin (the owner doesn't join).
export async function createCompanyForCustomer(owner: Owner, input: { name: string; domain: string; timeZone: string; adminEmail: string }) {
  const name = input.name.trim();
  const domain = input.domain.trim().toLowerCase();
  if (!name || name.length > 100) return { error: "Company name must be 1–100 characters." };
  if (!DOMAIN.test(domain)) return { error: "Enter a domain like acme.com." };
  if (!isTimeZone(input.timeZone)) return { error: "Choose a valid time zone." };
  const email = input.adminEmail.trim().toLowerCase();
  if (!email.endsWith(`@${domain}`)) return { error: `The first admin's email must be at ${domain}.` };
  let id = "";
  try {
    [{ id }] = await authDb.insert(companies).values({ name, domain, timeZone: input.timeZone }).returning({ id: companies.id });
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === "23505") return { error: `A company for ${domain} already exists.` };
    throw e;
  }
  // The owner acts with every permission here, so it may grant Company Admin.
  const access = { permissions: new Set(ALL_PERMISSIONS), managedDepartments: new Set<string>() };
  const error = await createInvitation({ id: owner.id, name: "The NotifyHub team", access }, id, email, [COMPANY_ADMIN_ROLE_ID]);
  return error ? { id, error: `Company created, but: ${error}` } : { id };
}

export async function editCompany(companyId: string, input: { name: string; domain: string; timeZone: string }) {
  const name = input.name.trim();
  const domain = input.domain.trim().toLowerCase();
  if (!name || name.length > 100) return "Company name must be 1–100 characters.";
  if (!DOMAIN.test(domain)) return "Enter a domain like acme.com.";
  if (!isTimeZone(input.timeZone)) return "Choose a valid time zone.";
  try {
    const done = await withTenant(companyId, (tx) =>
      tx.update(companies).set({ name, domain, timeZone: input.timeZone }).where(sql`${companies.id} = ${companyId}`).returning({ id: companies.id }),
    );
    return done.length ? null : "Company not found.";
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === "23505") return `Another company already uses ${domain}.`;
    throw e;
  }
}

export async function setSuspended(companyId: string, suspended: boolean) {
  const done = await withTenant(companyId, (tx) =>
    tx
      .update(companies)
      .set({ suspendedAt: suspended ? new Date() : null })
      .where(sql`${companies.id} = ${companyId}`)
      .returning({ id: companies.id }),
  );
  return done.length ? null : "Company not found.";
}

// Only an empty company: anything still referencing it (people, reminders,
// departments, invitations…) makes Postgres refuse, which is the guard.
export async function deleteEmptyCompany(companyId: string) {
  try {
    const done = await withTenant(companyId, (tx) => tx.delete(companies).where(sql`${companies.id} = ${companyId}`).returning({ id: companies.id }));
    return done.length ? null : "Company not found.";
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === "23503") return "This company isn't empty. Its people, reminders and departments must be removed first.";
    throw e;
  }
}

export async function platformSettingsRow() {
  const [row] = await db.select().from(platformSettings).where(sql`${platformSettings.id} = 1`);
  const member = await platformTx(async (tx) => {
    const r = (await tx.execute(sql`select permissions from roles where id = '00000000-0000-4000-8000-000000000002'`)) as unknown as Rows<{ permissions: string[] }>;
    return r.rows[0]?.permissions ?? [];
  });
  return { dailyVolumeAlert: row?.dailyVolumeAlert ?? null, memberPermissions: member };
}

export async function setVolumeAlert(value: number | null) {
  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 10_000_000)) return "Enter a whole number of deliveries, or leave it empty.";
  await db.insert(platformSettings).values({ id: 1, dailyVolumeAlert: value }).onConflictDoUpdate({ target: platformSettings.id, set: { dailyVolumeAlert: value } });
  return null;
}

export async function setMemberPermissions(perms: string[]) {
  const keep = [...new Set(perms)].filter(isPermission);
  await platformTx((tx) => tx.execute(sql`select platform_set_member_role(${sql.raw(`ARRAY[${keep.map((p) => `'${p}'`).join(",")}]::text[]`)})`));
  return null;
}
