import { aliasedTable, and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { departmentMembers, departments, user } from "@/db/schema";

class Refused extends Error {}

async function refusals(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof Refused) return e.message;
    if ((e as { cause?: { code?: string } }).cause?.code === "23505") return "That name is already taken.";
    throw e;
  }
  return null;
}

function cleanName(name: string) {
  name = name.trim();
  if (!name || name.length > 100) throw new Refused("Department name must be 1–100 characters.");
  return name;
}

export function listDepartments(companyId: string) {
  return withTenant(companyId, (tx) =>
    tx
      .select({ id: departments.id, name: departments.name, members: sql<number>`count(${departmentMembers.userId})::int` })
      .from(departments)
      .leftJoin(departmentMembers, eq(departmentMembers.departmentId, departments.id))
      .groupBy(departments.id)
      .orderBy(departments.name),
  );
}

export function getDepartment(companyId: string, id: string) {
  return withTenant(companyId, async (tx) => {
    const [dept] = await tx.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.id, id));
    if (!dept) return null;
    const members = await tx
      .select({ id: user.id, name: user.name, email: user.email, isManager: departmentMembers.isManager })
      .from(departmentMembers)
      .innerJoin(user, eq(user.id, departmentMembers.userId))
      .where(eq(departmentMembers.departmentId, id))
      .orderBy(user.name);
    const candidates = await tx
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(
        and(
          isNull(user.deactivatedAt),
          members.length
            ? notInArray(
                user.id,
                members.map((m) => m.id),
              )
            : undefined,
        ),
      )
      .orderBy(user.name);
    return { ...dept, members, candidates };
  });
}

export const createDepartment = (companyId: string, name: string) =>
  refusals(() => withTenant(companyId, (tx) => tx.insert(departments).values({ companyId, name: cleanName(name) })));

export const renameDepartment = (companyId: string, id: string, name: string) =>
  refusals(() =>
    withTenant(companyId, async (tx) => {
      const updated = await tx.update(departments).set({ name: cleanName(name) }).where(eq(departments.id, id)).returning();
      if (!updated.length) throw new Refused("Department not found.");
    }),
  );

// Memberships go with it (on delete cascade).
export const deleteDepartment = (companyId: string, id: string) =>
  refusals(() =>
    withTenant(companyId, async (tx) => {
      const deleted = await tx.delete(departments).where(eq(departments.id, id)).returning();
      if (!deleted.length) throw new Refused("Department not found.");
    }),
  );

export const addMember = (companyId: string, departmentId: string, userId: string) =>
  refusals(() =>
    withTenant(companyId, async (tx) => {
      // RLS: another company's department or user is simply not found.
      const [dept] = await tx.select({ id: departments.id }).from(departments).where(eq(departments.id, departmentId));
      if (!dept) throw new Refused("Department not found.");
      const [u] = await tx.select({ deactivatedAt: user.deactivatedAt }).from(user).where(eq(user.id, userId));
      if (!u) throw new Refused("User not found.");
      if (u.deactivatedAt) throw new Refused("That person is deactivated.");
      const added = await tx.insert(departmentMembers).values({ companyId, departmentId, userId }).onConflictDoNothing().returning();
      if (!added.length) throw new Refused("Already a member.");
    }),
  );

export const removeMember = (companyId: string, departmentId: string, userId: string) =>
  refusals(() =>
    withTenant(companyId, async (tx) => {
      const removed = await tx
        .delete(departmentMembers)
        .where(and(eq(departmentMembers.departmentId, departmentId), eq(departmentMembers.userId, userId)))
        .returning();
      if (!removed.length) throw new Refused("Not a member.");
    }),
  );

export const setManager = (companyId: string, departmentId: string, userId: string, isManager: boolean) =>
  refusals(() =>
    withTenant(companyId, async (tx) => {
      const updated = await tx
        .update(departmentMembers)
        .set({ isManager })
        .where(and(eq(departmentMembers.departmentId, departmentId), eq(departmentMembers.userId, userId)))
        .returning();
      if (!updated.length) throw new Refused("Only members can be managers.");
    }),
  );

// The managers of each department a person is in (their profile, PRD 3.3).
export function managersOfMyDepartments(companyId: string, userId: string) {
  const mine = aliasedTable(departmentMembers, "mine");
  return withTenant(companyId, (tx) =>
    tx
      .select({ departmentId: departmentMembers.departmentId, name: user.name })
      .from(departmentMembers)
      .innerJoin(mine, and(eq(mine.departmentId, departmentMembers.departmentId), eq(mine.userId, userId)))
      .innerJoin(user, eq(user.id, departmentMembers.userId))
      .where(eq(departmentMembers.isManager, true))
      .orderBy(user.name),
  );
}
