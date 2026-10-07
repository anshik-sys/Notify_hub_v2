import { and, asc, count, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { departmentMembers, departments, groupMembers, groups, reminders, reminderTargets, user } from "@/db/schema";
import { type Access, can } from "./permissions";
import { recheckGroupReminders } from "./reminders";

// Groups (PRD 4): custom distribution lists. Anyone with groups.create makes
// one; its creator or anyone with groups.manage edits it. Everyone who can see
// the directory can see a group's members, so they know who it reaches.
// Writes return an error string or null.

type Actor = { id: string; access: Access };
class Refused extends Error {}

async function refusals(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof Refused) return e.message;
    if ((e as { cause?: { code?: string } }).cause?.code === "23505") return "A group with that name already exists.";
    throw e;
  }
  return null;
}

function cleanName(name: string) {
  name = name.trim();
  if (!name || name.length > 100) throw new Refused("Group name must be 1–100 characters.");
  return name;
}

export const mayEditGroup = (actor: Actor, g: { createdBy: string | null }) => g.createdBy === actor.id || can(actor.access, "groups.manage");

export function listGroups(companyId: string) {
  return withTenant(companyId, (tx) =>
    tx
      .select({
        id: groups.id,
        name: groups.name,
        createdBy: groups.createdBy,
        creatorName: user.name,
        members: sql<number>`(select count(*) from group_members gm join "user" u on u.id = gm.user_id
          where gm.group_id = ${groups.id} and u.deactivated_at is null)::int`,
      })
      .from(groups)
      .leftJoin(user, eq(user.id, groups.createdBy))
      .orderBy(asc(sql`lower(${groups.name})`)),
  );
}

// Groups a person is in (Home).
export function groupsOf(companyId: string, userId: string) {
  return withTenant(companyId, (tx) =>
    tx
      .select({ id: groups.id, name: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(eq(groupMembers.userId, userId))
      .orderBy(groups.name),
  );
}

export function getGroup(companyId: string, id: string) {
  return withTenant(companyId, async (tx) => {
    const [g] = await tx
      .select({ id: groups.id, name: groups.name, createdBy: groups.createdBy, creatorName: user.name })
      .from(groups)
      .leftJoin(user, eq(user.id, groups.createdBy))
      .where(eq(groups.id, id));
    if (!g) return null;
    const members = await tx
      .select({ id: user.id, name: user.name, email: user.email, deactivatedAt: user.deactivatedAt })
      .from(groupMembers)
      .innerJoin(user, eq(user.id, groupMembers.userId))
      .where(eq(groupMembers.groupId, id))
      .orderBy(user.name);
    const depts = members.length
      ? await tx
          .select({ userId: departmentMembers.userId, name: departments.name })
          .from(departmentMembers)
          .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
          .where(inArray(departmentMembers.userId, members.map((m) => m.id)))
          .orderBy(departments.name)
      : [];
    const candidates = await tx
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(and(isNull(user.deactivatedAt), members.length ? notInArray(user.id, members.map((m) => m.id)) : undefined))
      .orderBy(user.name);
    const [{ used }] = await tx
      .select({ used: count() })
      .from(reminderTargets)
      .innerJoin(reminders, eq(reminders.id, reminderTargets.reminderId))
      .where(and(eq(reminderTargets.kind, "group"), eq(reminderTargets.ref, id), inArray(reminders.status, ["pending_approval", "scheduled", "paused"])));
    return {
      ...g,
      members: members.map((m) => ({ ...m, departments: depts.filter((d) => d.userId === m.id).map((d) => d.name) })),
      candidates,
      used,
    };
  });
}

// Returns the new group's id, or an error.
export async function createGroup(actor: Actor, companyId: string, name: string): Promise<{ id: string } | { error: string }> {
  if (!can(actor.access, "groups.create")) return { error: "You can't create groups." };
  let id = "";
  const error = await refusals(async () => {
    const [row] = await withTenant(companyId, (tx) =>
      tx.insert(groups).values({ companyId, name: cleanName(name), createdBy: actor.id }).returning({ id: groups.id }),
    );
    id = row.id;
  });
  return error ? { error } : { id };
}

// Loads the group and checks edit rights, inside the caller's transaction.
async function editable(tx: Parameters<Parameters<typeof withTenant>[1]>[0], actor: Actor, id: string) {
  const [g] = await tx.select({ createdBy: groups.createdBy }).from(groups).where(eq(groups.id, id)).for("update");
  if (!g) throw new Refused("Group not found.");
  if (!mayEditGroup(actor, g)) throw new Refused("Only the group's creator or an admin can change it.");
}

export const renameGroup = (actor: Actor, companyId: string, id: string, name: string) =>
  refusals(() =>
    withTenant(companyId, async (tx) => {
      await editable(tx, actor, id);
      await tx.update(groups).set({ name: cleanName(name) }).where(eq(groups.id, id));
    }),
  );

// Refused while a live reminder targets it, so a schedule never silently
// loses its recipients.
export const deleteGroup = (actor: Actor, companyId: string, id: string) =>
  refusals(() =>
    withTenant(companyId, async (tx) => {
      await editable(tx, actor, id);
      const [{ used }] = await tx
        .select({ used: count() })
        .from(reminderTargets)
        .innerJoin(reminders, eq(reminders.id, reminderTargets.reminderId))
        .where(and(eq(reminderTargets.kind, "group"), eq(reminderTargets.ref, id), inArray(reminders.status, ["pending_approval", "scheduled", "paused"])));
      if (used) throw new Refused(`Used by ${used} upcoming reminder${used === 1 ? "" : "s"}. Remove the group from ${used === 1 ? "it" : "them"} first.`);
      await tx.delete(groups).where(eq(groups.id, id));
    }),
  );

// Active people of this company only (others are ignored). Returns how many
// scheduled reminders now need approval because of who was added.
export async function addGroupMembers(actor: Actor, companyId: string, id: string, userIds: string[]) {
  let added: string[] = [];
  const error = await refusals(() =>
    withTenant(companyId, async (tx) => {
      await editable(tx, actor, id);
      const people = userIds.length
        ? await tx.select({ id: user.id }).from(user).where(and(inArray(user.id, [...new Set(userIds)]), isNull(user.deactivatedAt)))
        : [];
      if (!people.length) throw new Refused("Pick someone to add.");
      const rows = await tx
        .insert(groupMembers)
        .values(people.map((p) => ({ groupId: id, companyId, userId: p.id })))
        .onConflictDoNothing()
        .returning({ userId: groupMembers.userId });
      added = rows.map((r) => r.userId);
    }),
  );
  if (error) return { error };
  return { needApproval: await recheckGroupReminders(companyId, id, added) };
}

export const removeGroupMember = (actor: Actor, companyId: string, id: string, userId: string) =>
  refusals(() =>
    withTenant(companyId, async (tx) => {
      await editable(tx, actor, id);
      await tx.delete(groupMembers).where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, userId)));
    }),
  );
