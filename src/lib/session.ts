import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { loadAccess } from "./permissions";

// For every page and server action behind sign-in: a session, a company, and
// the user's permissions. Callers still check can() for what they do.
export async function requireMember() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const companyId = session.user.companyId;
  if (!companyId) redirect("/onboarding");
  return { user: session.user, companyId, access: await loadAccess(companyId, session.user.id) };
}
