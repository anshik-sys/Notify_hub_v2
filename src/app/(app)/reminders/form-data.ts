import { eq, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import { departmentMembers, user } from "@/db/schema";
import { listDepartments } from "@/lib/departments";
import { can, type Access } from "@/lib/permissions";
import { listUsers } from "@/lib/users";

export type Person = { id: string; name: string; email: string };
export type DepartmentChoice = { id: string; name: string; mine: boolean; members: Person[] };

// Choices for the recipient pickers: every department with its active
// members (yours first), and the directory for the people search (only for
// those allowed to see the directory).
export async function recipientChoices(companyId: string, userId: string, access: Access) {
  const [departments, memberships, people] = await Promise.all([
    listDepartments(companyId),
    withTenant(companyId, (tx) =>
      tx
        .select({ departmentId: departmentMembers.departmentId, id: user.id, name: user.name, email: user.email })
        .from(departmentMembers)
        .innerJoin(user, eq(user.id, departmentMembers.userId))
        .where(isNull(user.deactivatedAt))
        .orderBy(user.name),
    ),
    can(access, "users.view") ? listUsers(companyId).then((r) => r.users.filter((u) => !u.deactivatedAt)) : [],
  ]);
  const choices: DepartmentChoice[] = departments.map((d) => {
    const members = memberships.filter((m) => m.departmentId === d.id).map(({ id, name, email }) => ({ id, name, email }));
    return { id: d.id, name: d.name, mine: members.some((m) => m.id === userId), members };
  });
  choices.sort((a, b) => Number(b.mine) - Number(a.mine));
  return { departments: choices, people: people.map(({ id, name, email }) => ({ id, name, email })) };
}

