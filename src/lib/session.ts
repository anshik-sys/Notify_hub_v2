import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";
import { redirect } from "next/navigation";
import { withTenant } from "@/db";
import { companies } from "@/db/schema";
import { auth } from "./auth";
import { loadAccess } from "./permissions";

// For every page and server action behind sign-in: a session, the company,
// and the user's permissions. Callers still check can() for what they do.
// cache(): the app layout and the page both call this; one lookup per request.
export const requireMember = cache(async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  // Deactivation deletes sessions too; this covers the moment in between.
  if (!session || session.user.deactivatedAt) redirect("/sign-in");
  const companyId = session.user.companyId;
  if (!companyId) redirect("/onboarding");
  const [access, [company]] = await Promise.all([
    loadAccess(companyId, session.user.id),
    withTenant(companyId, (tx) =>
      tx.select({ name: companies.name, timeZone: companies.timeZone }).from(companies).where(eq(companies.id, companyId)),
    ),
  ]);
  return { user: session.user, companyId, company, access };
});
