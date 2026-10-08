import { exportPerson, exportResponse } from "@/lib/privacy";
import { limit } from "@/lib/rate-limit";
import { requireMember } from "@/lib/session";

// PRD 11.5: anyone can download what NotifyHub holds about them.
export async function GET() {
  const { user, companyId } = await requireMember();
  if (!(await limit(`export:user:${user.id}`, 10, 3600)).ok) return new Response("Too many exports. Try again later.", { status: 429 });
  return exportResponse(await exportPerson(companyId, user.id), user.id);
}
