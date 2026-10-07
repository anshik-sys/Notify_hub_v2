import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { invitations, roles, session, user, userRoles } from "@/db/schema";
import { authDb } from "./auth";
import { type Access, canGrant, COMPANY_ADMIN_ROLE_ID, MEMBER_ROLE_ID } from "./permissions";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];
type Actor = { id: string; access: Access };
class Refused extends Error {}

export async function listUsers(companyId: string) {
  return withTenant(companyId, async (tx) => {
    const people = await tx
      .select({ id: user.id, name: user.name, email: user.email, deactivatedAt: user.deactivatedAt })
      .from(user)
      .orderBy(user.name);
    const held = await tx
      .select({ userId: userRoles.userId, name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .orderBy(roles.name);
    const pending = await tx
      .select({ id: invitations.id, email: invitations.email, expiresAt: invitations.expiresAt })
      .from(invitations)
      .where(and(isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())))
      .orderBy(invitations.email);
    return {
      users: people.map((p) => ({ ...p, roles: held.filter((h) => h.userId === p.id).map((h) => h.name) })),
      pending,
    };
  });
}

export async function getUser(companyId: string, userId: string) {
  return withTenant(companyId, async (tx) => {
    const [u] = await tx
      .select({ id: user.id, name: user.name, email: user.email, deactivatedAt: user.deactivatedAt })
      .from(user)
      .where(eq(user.id, userId));
    if (!u) return null;
    const held = await tx.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId));
    return { ...u, roleIds: held.map((h) => h.roleId) };
  });
}

// Locks the company row so concurrent role/activation changes run one at a
// time, then (after the change) refuses if no active admin would remain.
async function lockCompany(tx: Tx, companyId: string) {
  await tx.execute(sql`select 1 from companies where id = ${companyId} for update`);
}
async function assertAdminRemains(tx: Tx) {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(userRoles)
    .innerJoin(user, eq(user.id, userRoles.userId))
    .where(and(eq(userRoles.roleId, COMPANY_ADMIN_ROLE_ID), isNull(user.deactivatedAt)));
  if (n === 0) throw new Refused("The company needs at least one active Company Admin.");
}

// You can act on someone only if you could grant every role they hold.
async function assertCanManage(tx: Tx, actor: Actor, userId: string) {
  const held = await tx
    .select({ id: roles.id, name: roles.name, permissions: roles.permissions })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));
  const above = held.find((r) => !canGrant(actor.access, r));
  if (above) throw new Refused(`You can't manage someone with the ${above.name} role.`);
  return held;
}

export async function setUserRoles(actor: Actor, companyId: string, userId: string, roleIds: string[]) {
  try {
    await withTenant(companyId, async (tx) => {
      await lockCompany(tx, companyId);
      const [target] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId));
      if (!target) throw new Refused("User not found.");
      const held = await assertCanManage(tx, actor, userId);

      // Member is the baseline everyone keeps.
      const wanted = [...new Set([MEMBER_ROLE_ID, ...roleIds])];
      const found = await tx.select().from(roles).where(inArray(roles.id, wanted));
      if (found.length !== wanted.length) throw new Refused("Unknown role.");
      const added = found.filter((r) => !held.some((h) => h.id === r.id));
      const removed = held.filter((h) => !wanted.includes(h.id));
      const forbidden = added.find((r) => !canGrant(actor.access, r));
      if (forbidden) throw new Refused(`You can't grant the ${forbidden.name} role.`);

      if (removed.length)
        await tx.delete(userRoles).where(
          and(
            eq(userRoles.userId, userId),
            inArray(
              userRoles.roleId,
              removed.map((r) => r.id),
            ),
          ),
        );
      if (added.length) await tx.insert(userRoles).values(added.map((r) => ({ companyId, userId, roleId: r.id })));
      await assertAdminRemains(tx);
    });
  } catch (e) {
    if (e instanceof Refused) return e.message;
    throw e;
  }
  return null;
}

export async function setActive(actor: Actor, companyId: string, userId: string, active: boolean) {
  if (!active && userId === actor.id) return "You can't deactivate yourself.";
  try {
    await withTenant(companyId, async (tx) => {
      await lockCompany(tx, companyId);
      await assertCanManage(tx, actor, userId);
      const updated = await tx
        .update(user)
        .set({ deactivatedAt: active ? null : new Date() })
        .where(eq(user.id, userId))
        .returning({ id: user.id });
      if (updated.length === 0) throw new Refused("User not found.");
      await assertAdminRemains(tx);
    });
  } catch (e) {
    if (e instanceof Refused) return e.message;
    throw e;
  }
  // The app role has no access to sessions. Between these two statements the
  // old session still exists, but requireMember() already refuses it.
  if (!active) await authDb.delete(session).where(eq(session.userId, userId));
  return null;
}
