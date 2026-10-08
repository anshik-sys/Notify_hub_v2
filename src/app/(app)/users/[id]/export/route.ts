import { notFound } from "next/navigation";
import { can } from "@/lib/permissions";
import { exportPerson, exportResponse } from "@/lib/privacy";
import { limit } from "@/lib/rate-limit";
import { requireMember } from "@/lib/session";
import { canManagePerson } from "@/lib/users";

// PRD 11.5: an admin exports one person's data (JSON download). Same rule as
// deactivating: users.edit, and nobody above you.
export async function GET(_req: Request, ctx: RouteContext<"/users/[id]/export">) {
  const { id } = await ctx.params;
  const { user, companyId, access } = await requireMember();
  if (!can(access, "users.edit") || id.length > 64 || !(await canManagePerson({ id: user.id, access }, companyId, id))) notFound();
  if (!(await limit(`export:user:${user.id}`, 10, 3600)).ok) return new Response("Too many exports. Try again later.", { status: 429 });
  return exportResponse(await exportPerson(companyId, id), id);
}
