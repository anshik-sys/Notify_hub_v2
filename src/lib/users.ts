import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { cache } from "react";
import { withTenant } from "@/db";
import { departmentMembers, departments, googleCalendars, invitations, roles, session, user, userPhotos, userRoles } from "@/db/schema";
import { decrypt } from "./crypto";
import { teardown } from "./google";
import { listMySessions, resetTwoFactor } from "./account";
import { authDb } from "./auth";
import { checkImage } from "./company";
import { type Access, can, canGrant, COMPANY_ADMIN_ROLE_ID, MEMBER_ROLE_ID } from "./permissions";
import { deletePhoto, getPhoto, putPhoto } from "./storage";
import { PAGE_SIZE } from "./views";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];
type Actor = { id: string; access: Access };
class Refused extends Error {}

// The directory (PRD 4): q matches name, email or a department's name.
// With a page, returns PAGE_SIZE people from it; without, everyone (pickers).
export async function listUsers(companyId: string, q = "", page?: number) {
  const like = `%${q.trim().replace(/[\\%_]/g, "\\$&")}%`;
  return withTenant(companyId, async (tx) => {
    const query = tx
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        deactivatedAt: user.deactivatedAt,
        total: sql<number>`count(*) over ()::int`,
      })
      .from(user)
      .where(
        and(
          isNull(user.erasedAt),
          q.trim()
          ? sql`${user.name} ilike ${like} or ${user.email} ilike ${like} or exists (select 1 from department_members m
              join departments d on d.id = m.department_id where m.user_id = ${user.id} and d.name ilike ${like})`
            : undefined,
        ),
      )
      .orderBy(user.name, asc(user.id))
      .$dynamic();
    const rows = page ? await query.limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE) : await query;
    const people = rows;
    const ids = people.map((p) => p.id);
    const memberOf = await tx
      .select({ userId: departmentMembers.userId, name: departments.name, isManager: departmentMembers.isManager })
      .from(departmentMembers)
      .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
      .where(inArray(departmentMembers.userId, ids))
      .orderBy(departments.name);
    const held = await tx
      .select({ userId: userRoles.userId, name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(inArray(userRoles.userId, ids))
      .orderBy(roles.name);
    const pending = await tx
      .select({ id: invitations.id, email: invitations.email, expiresAt: invitations.expiresAt })
      .from(invitations)
      .where(and(isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())))
      .orderBy(invitations.email);
    return {
      users: people.map((p) => ({
        ...p,
        roles: held.filter((h) => h.userId === p.id).map((h) => h.name),
        departments: memberOf.filter((m) => m.userId === p.id).map(({ name, isManager }) => ({ name, isManager })),
      })),
      pending,
      total: rows[0]?.total ?? 0,
    };
  });
}

export async function getUser(companyId: string, userId: string) {
  return withTenant(companyId, async (tx) => {
    const [u] = await tx
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        deactivatedAt: user.deactivatedAt,
        twoFactorEnabled: user.twoFactorEnabled,
        erasedAt: user.erasedAt,
      })
      .from(user)
      .where(eq(user.id, userId));
    if (!u) return null;
    const held = await tx.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId));
    const memberOf = await tx
      .select({ id: departments.id, name: departments.name, isManager: departmentMembers.isManager })
      .from(departmentMembers)
      .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
      .where(eq(departmentMembers.userId, userId))
      .orderBy(departments.name);
    return { ...u, roleIds: held.map((h) => h.roleId), departments: memberOf };
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

// PRD 9.1: an admin resets someone's 2FA (lost phone). The caller has
// checked users.edit; like deactivation, nobody can do it to someone above them.
export async function adminResetTwoFactor(actor: Actor, companyId: string, userId: string) {
  if (userId === actor.id) return "Turn your own 2FA off under Settings → Security.";
  try {
    await withTenant(companyId, async (tx) => {
      const [target] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId));
      if (!target) throw new Refused("User not found.");
      await assertCanManage(tx, actor, userId);
    });
  } catch (e) {
    if (e instanceof Refused) return e.message;
    throw e;
  }
  await resetTwoFactor(userId);
  return null;
}

// For reads about one person (data export): the same "not above you" rule.
export async function canManagePerson(actor: Actor, companyId: string, userId: string) {
  try {
    return await withTenant(companyId, async (tx) => {
      const [target] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId));
      if (!target) return false;
      await assertCanManage(tx, actor, userId);
      return true;
    });
  } catch (e) {
    if (e instanceof Refused) return false;
    throw e;
  }
}

// PRD 11.5: permanently erase a deactivated person's personal data. The
// work is the erase_person SQL function (migration 0028), shared with the
// nightly retention job. Same guard as deactivation: nobody above you.
export async function erasePerson(actor: Actor, companyId: string, userId: string) {
  if (!can(actor.access, "users.delete")) return "You can't erase people.";
  if (userId === actor.id) return "You can't erase yourself.";
  let google: { refreshTokenEnc: string; calendarId: string | null } | undefined;
  try {
    await withTenant(companyId, async (tx) => {
      const [target] = await tx.select({ deactivatedAt: user.deactivatedAt, erasedAt: user.erasedAt }).from(user).where(eq(user.id, userId));
      if (!target) throw new Refused("User not found.");
      if (target.erasedAt) throw new Refused("Already erased.");
      if (!target.deactivatedAt) throw new Refused("Deactivate them first. Erasing can't be undone.");
      await assertCanManage(tx, actor, userId);
      // erase_person deletes the Google connection; keep what's needed to remove their calendar after (GC8).
      [google] = await tx.select({ refreshTokenEnc: googleCalendars.refreshTokenEnc, calendarId: googleCalendars.calendarId }).from(googleCalendars).where(eq(googleCalendars.userId, userId));
      await tx.execute(sql`select erase_person(${userId})`);
    }, actor.id); // attributed explicitly: the audit row for erased_at names the admin
  } catch (e) {
    if (e instanceof Refused) return e.message;
    throw e;
  }
  // Best effort, after the erase is committed.
  if (google) await teardown({ refreshToken: decrypt(google.refreshTokenEnc), calendarId: google.calendarId }).catch(() => {});
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

// PRD 9.1: an admin fixes someone's name (users.edit; not someone above them).
// Email stays theirs to change: it needs the new address verified (PRD 3.3).
export async function renamePerson(actor: Actor, companyId: string, userId: string, name: string) {
  name = name.trim();
  if (!name || name.length > 100) return "Name must be 1–100 characters.";
  try {
    await withTenant(companyId, async (tx) => {
      await assertCanManage(tx, actor, userId);
      const updated = await tx
        .update(user)
        .set({ name })
        .where(and(eq(user.id, userId), isNull(user.erasedAt)))
        .returning({ id: user.id });
      if (!updated.length) throw new Refused("User not found.");
    });
  } catch (e) {
    if (e instanceof Refused) return e.message;
    throw e;
  }
  return null;
}

// PRD 9.1 "Active sessions": where someone is signed in, for those who may
// manage them; null otherwise. No tokens leave this function.
export async function personSessions(actor: Actor, companyId: string, userId: string) {
  if (!(await canManagePerson(actor, companyId, userId))) return null;
  return (await listMySessions(userId)).map(({ id, ipAddress, userAgent, createdAt, updatedAt }) => ({ id, ipAddress, userAgent, createdAt, updatedAt }));
}

export async function signOutPerson(actor: Actor, companyId: string, userId: string) {
  if (userId === actor.id) return "Sign yourself out under Settings → Security.";
  if (!(await canManagePerson(actor, companyId, userId))) return "You can't manage this person.";
  await authDb.delete(session).where(eq(session.userId, userId));
  return null;
}

// --- Profile photos (PRD 3.3) ---------------------------------------------------

export const PHOTO_MAX_BYTES = 1024 * 1024;

// Your own photo; replaces any earlier one.
export async function setPhoto(actor: { id: string }, companyId: string, fileName: string, bytes: Uint8Array) {
  const checked = checkImage(fileName, bytes, PHOTO_MAX_BYTES, "photo");
  if ("error" in checked) return checked.error;
  await withTenant(companyId, (tx) => putPhoto(tx, companyId, actor.id, checked.image.contentType, checked.image.data));
  return null;
}

// Your own, or (users.edit, checked by the caller) someone you may manage:
// e.g. an unsuitable picture. Nobody uploads one for someone else.
export async function removePhoto(actor: Actor, companyId: string, userId: string) {
  try {
    await withTenant(companyId, async (tx) => {
      if (userId !== actor.id) await assertCanManage(tx, actor, userId);
      if (!(await deletePhoto(tx, userId)).length) throw new Refused("There's no photo to remove.");
    });
  } catch (e) {
    if (e instanceof Refused) return e.message;
    throw e;
  }
  return null;
}

// For /api/avatar/<user id>: same company only (RLS).
export const photoFile = (companyId: string, userId: string) => withTenant(companyId, (tx) => getPhoto(tx, userId));

// User id → photo URL for everyone in the company who has one; once per
// request. The ?v= changes with the photo, so the long cache never goes stale.
export const photoUrls = cache(async (companyId: string) => {
  const rows = await withTenant(companyId, (tx) => tx.select({ userId: userPhotos.userId, at: userPhotos.updatedAt }).from(userPhotos));
  return new Map(rows.map((r) => [r.userId, `/api/avatar/${encodeURIComponent(r.userId)}?v=${r.at.getTime()}`]));
});
