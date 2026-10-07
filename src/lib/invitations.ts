import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { companies, departmentMembers, departments, invitations, roles, user, userRoles } from "@/db/schema";
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
    await sendMail({
      to: email,
      subject: `You're invited to ${companyName} on NotifyHub`,
      text: `${actor.name} invited you to join ${companyName} on NotifyHub. The link expires in ${INVITE_DAYS} days.`,
      links: [{ label: "Accept invite", url: `${process.env.BETTER_AUTH_URL}/invite/${token}` }],
    });
  } catch (e) {
    console.error("invite email failed", e);
    return "The invite was saved but the email failed to send. Try inviting again.";
  }
  return null;
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
