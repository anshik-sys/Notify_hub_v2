import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { companies, departmentMembers, departments, invitations, roles, user, userRoles } from "@/db/schema";
import { csvFormulaCheck, parseCsv } from "./attachments";
import { authDb } from "./auth";
import { sendMail } from "./mail";
import { type Access, canGrant, MEMBER_ROLE_ID } from "./permissions";

const INVITE_DAYS = 7;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Thrown inside a transaction to roll it back with a user-facing message.
class Refused extends Error {}

export async function createInvitation(
  actor: { id: string; name: string; access: Access },
  companyId: string,
  rawEmail: string,
  roleIds: string[],
  departmentIds: string[] = [],
) {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL.test(email)) return "Enter a valid email address.";
  const token = randomBytes(32).toString("base64url");

  let companyName: string;
  try {
    companyName = await withTenant(companyId, async (tx) => {
      const [member] = await tx.select({ id: user.id }).from(user).where(eq(sql`lower(${user.email})`, email));
      if (member) throw new Refused(`${email} is already a member.`);
      const wanted = [...new Set(roleIds)];
      const found = wanted.length ? await tx.select().from(roles).where(inArray(roles.id, wanted)) : [];
      if (found.length !== wanted.length) throw new Refused("Unknown role.");
      const forbidden = found.find((r) => !canGrant(actor.access, r));
      if (forbidden) throw new Refused(`You can't grant the ${forbidden.name} role.`);
      const depts = [...new Set(departmentIds)];
      const foundDepts = depts.length ? await tx.select({ id: departments.id }).from(departments).where(inArray(departments.id, depts)) : [];
      if (foundDepts.length !== depts.length) throw new Refused("Unknown department.");

      await tx
        .delete(invitations)
        .where(and(eq(invitations.companyId, companyId), eq(invitations.email, email), isNull(invitations.acceptedAt)));
      await tx.insert(invitations).values({
        companyId,
        email,
        roleIds: wanted,
        departmentIds: depts,
        invitedBy: actor.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
      });
      const [c] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
      return c.name;
    });
  } catch (e) {
    if (e instanceof Refused) return e.message;
    throw e;
  }

  // Awaited: the admin should hear about a failed send. The invite row stays;
  // inviting again replaces it.
  try {
    await inviteEmail(email, actor.name, companyName, token);
  } catch (e) {
    console.error("invite email failed", e);
    return "The invite was saved but the email failed to send. Try inviting again.";
  }
  return null;
}

const inviteEmail = (to: string, from: string, companyName: string, token: string) =>
  sendMail({
    to,
    subject: `You're invited to ${companyName} on NotifyHub`,
    text: `${from} invited you to join ${companyName} on NotifyHub. The link expires in ${INVITE_DAYS} days.`,
    links: [{ label: "Accept invite", url: `${process.env.BETTER_AUTH_URL}/invite/${token}` }],
  });

export const IMPORT_MAX_ROWS = 200;

// PRD 9.1 bulk import: CSV with a header row: email (required), departments
// and roles (optional, names separated by ";"; Member is always included).
// All-or-nothing: any bad row and nothing is created. Existing members are
// skipped, not errors. Returns sendAll() for the caller to run after the
// response (a few hundred emails shouldn't hold the request open).
export async function importInvitations(actor: { id: string; name: string; access: Access }, companyId: string, text: string) {
  const errors: string[] = [];
  if (csvFormulaCheck(text)) return { errors: ["The file contains a cell starting with = + - or @ (a spreadsheet formula). Remove it and try again."] };
  const rows = parseCsv(text.replace(/^\uFEFF/, "")).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return { errors: ["The file is empty."] };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  if (col("email") < 0) return { errors: ['The first row must be a header with an "email" column.'] };
  const data = rows.slice(1);
  if (!data.length) return { errors: ["No people in the file, only the header."] };
  if (data.length > IMPORT_MAX_ROWS) return { errors: [`At most ${IMPORT_MAX_ROWS} people per import (this file has ${data.length}).`] };

  return withTenant(companyId, async (tx) => {
    const [allDepts, allRoles, members, [company]] = await Promise.all([
      tx.select({ id: departments.id, name: departments.name }).from(departments),
      tx.select().from(roles),
      tx.select({ email: user.email }).from(user),
      tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)),
    ]);
    const deptByName = new Map(allDepts.map((d) => [d.name.toLowerCase(), d.id]));
    const roleByName = new Map(allRoles.map((r) => [r.name.toLowerCase(), r]));
    const existing = new Set(members.map((m) => m.email.toLowerCase()));
    const list = (r: string[], name: string) => (col(name) < 0 ? [] : (r[col(name)] ?? "").split(";").map((x) => x.trim()).filter(Boolean));
    const seen = new Set<string>();
    const wanted: { email: string; roleIds: string[]; departmentIds: string[] }[] = [];
    const skipped: string[] = [];
    data.forEach((r, i) => {
      const n = i + 2; // spreadsheet row number
      const email = (r[col("email")] ?? "").trim().toLowerCase();
      if (!EMAIL.test(email)) return void errors.push(`Row ${n}: "${email || "(empty)"}" isn't a valid email.`);
      if (seen.has(email)) return void errors.push(`Row ${n}: ${email} appears more than once.`);
      seen.add(email);
      const departmentIds: string[] = [];
      for (const d of list(r, "departments")) {
        const id = deptByName.get(d.toLowerCase());
        if (id) departmentIds.push(id);
        else errors.push(`Row ${n}: unknown department "${d}".`);
      }
      const roleIds = [MEMBER_ROLE_ID];
      for (const name of list(r, "roles")) {
        const role = roleByName.get(name.toLowerCase());
        if (!role) errors.push(`Row ${n}: unknown role "${name}".`);
        else if (!canGrant(actor.access, role)) errors.push(`Row ${n}: you can't grant the ${role.name} role.`);
        else if (!roleIds.includes(role.id)) roleIds.push(role.id);
      }
      if (existing.has(email)) skipped.push(email);
      else wanted.push({ email, roleIds, departmentIds: [...new Set(departmentIds)] });
    });
    if (errors.length) return { errors: errors.slice(0, 20).concat(errors.length > 20 ? [`…and ${errors.length - 20} more.`] : []) };

    const tokens: { email: string; token: string }[] = [];
    for (const w of wanted) {
      const token = randomBytes(32).toString("base64url");
      await tx.delete(invitations).where(and(eq(invitations.companyId, companyId), eq(invitations.email, w.email), isNull(invitations.acceptedAt)));
      await tx.insert(invitations).values({
        companyId,
        email: w.email,
        roleIds: w.roleIds,
        departmentIds: w.departmentIds,
        invitedBy: actor.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
      });
      tokens.push({ email: w.email, token });
    }
    const sendAll = async () => {
      for (const t of tokens)
        await inviteEmail(t.email, actor.name, company.name, t.token).catch((e) => console.error("import invite email failed", t.email, e));
    };
    return { invited: wanted.map((w) => w.email), skipped, sendAll };
  });
}

// Public lookup for the accept page, before any company is known.
export async function findInvitation(token: string) {
  const [invite] = await authDb
    .select({
      email: invitations.email,
      companyName: companies.name,
      acceptedAt: invitations.acceptedAt,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .innerJoin(companies, eq(companies.id, invitations.companyId))
    .where(eq(invitations.tokenHash, hashToken(token)));
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) return null;
  return { email: invite.email, companyName: invite.companyName };
}

// Claims the invite and attaches the user, atomically. Returns an error or null.
export async function acceptInvitation(token: string, userId: string) {
  try {
    await authDb.transaction(async (tx) => {
      // Single use: only one claim can match accepted_at IS NULL.
      const [invite] = await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(invitations.tokenHash, hashToken(token)),
            isNull(invitations.acceptedAt),
            gt(invitations.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!invite) throw new Refused("This invite is invalid, expired or already used.");

      // The emailed link proves the mailbox, so the email counts as verified.
      const attached = await tx
        .update(user)
        .set({ companyId: invite.companyId, emailVerified: true })
        .where(and(eq(user.id, userId), isNull(user.companyId), eq(sql`lower(${user.email})`, invite.email)))
        .returning({ id: user.id });
      if (attached.length === 0) throw new Refused("This account can't accept this invite.");

      // Scope the rest to the invite's company, so the role lookup sees its custom roles.
      await tx.execute(sql`select set_config('app.company_id', ${invite.companyId}, true)`);
      const valid = invite.roleIds.length
        ? await tx.select({ id: roles.id }).from(roles).where(inArray(roles.id, invite.roleIds))
        : [];
      // Roles deleted since the invite are skipped; everyone is at least a Member.
      const roleIds = [...new Set([MEMBER_ROLE_ID, ...valid.map((r) => r.id)])];
      await tx.insert(userRoles).values(roleIds.map((roleId) => ({ companyId: invite.companyId, userId, roleId })));

      // Departments deleted since the invite are skipped. Never as manager.
      const depts = invite.departmentIds.length
        ? await tx.select({ id: departments.id }).from(departments).where(inArray(departments.id, invite.departmentIds))
        : [];
      if (depts.length)
        await tx
          .insert(departmentMembers)
          .values(depts.map((d) => ({ companyId: invite.companyId, departmentId: d.id, userId })));
    });
  } catch (e) {
    if (e instanceof Refused) return e.message;
    throw e;
  }
  return null;
}

export async function revokeInvitation(companyId: string, id: string) {
  await withTenant(companyId, (tx) =>
    tx.delete(invitations).where(and(eq(invitations.id, id), isNull(invitations.acceptedAt))),
  );
}

// For the accept page only: the token holder owns this mailbox, so telling
// them their account exists leaks nothing.
export async function accountExists(email: string) {
  const [u] = await authDb.select({ id: user.id }).from(user).where(eq(sql`lower(${user.email})`, email));
  return Boolean(u);
}
