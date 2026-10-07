import { listDepartments } from "@/lib/departments";
import { can, type Access } from "@/lib/permissions";
import { listUsers } from "@/lib/users";

// Choices for the recipient pickers. People only for those who may see the directory.
export async function recipientChoices(companyId: string, access: Access) {
  const [departments, people] = await Promise.all([
    listDepartments(companyId),
    can(access, "users.view") ? listUsers(companyId).then((r) => r.users.filter((u) => !u.deactivatedAt)) : [],
  ]);
  return {
    departments: departments.map((d) => ({ value: d.id, label: d.name })),
    people: people.map((p) => ({ value: p.id, label: `${p.name} (${p.email})` })),
  };
}
