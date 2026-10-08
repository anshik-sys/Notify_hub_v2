import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";
import { redirect } from "next/navigation";
import { setCurrentActor, withTenant } from "@/db";
import { companies } from "@/db/schema";
import { auth } from "./auth";
import { loadAccess } from "./permissions";

// PRD 9.1: the company requires 2FA and this person hasn't set it up.
export const needsTwoFactorSetup = (company: { requireTwoFactor: boolean }, user: { twoFactorEnabled?: boolean | null }) =>
  company.requireTwoFactor && !user.twoFactorEnabled;

// For every page and server action behind sign-in: a session, the company,
// and the user's permissions. Callers still check can() for what they do.
// cache(): the app layout and the page both call this; one lookup per request.
// If the company requires 2FA and the person hasn't set it up, everything
// redirects to the security page; only that page and its actions pass
// allowWithout2fa = true.
export const requireMember = cache(async (allowWithout2fa: boolean = false) => {
  const session = await auth.api.getSession({ headers: await headers() });
  // Deactivation deletes sessions too; this covers the moment in between.
  if (!session || session.user.deactivatedAt) redirect("/sign-in");
  const companyId = session.user.companyId;
  if (!companyId) redirect("/onboarding");
  await setCurrentActor(session.user.id); // attributes this request's writes in the audit log
  const [access, [company]] = await Promise.all([
    loadAccess(companyId, session.user.id),
    withTenant(companyId, (tx) =>
      tx
        .select({
          name: companies.name,
          timeZone: companies.timeZone,
          requireTwoFactor: companies.requireTwoFactor,
          defaultSenderName: companies.defaultSenderName,
          suspendedAt: companies.suspendedAt,
        })
        .from(companies)
        .where(eq(companies.id, companyId)),
    ),
  ]);
  // PRD 9.2: a suspended company's people see only the suspended page.
  if (company.suspendedAt) redirect("/suspended");
  if (!allowWithout2fa && needsTwoFactorSetup(company, session.user)) redirect("/settings/security?required=1");
  // For display; reminders keep their own zone for scheduling.
  const timeZone = session.user.timeZone || company.timeZone;
  return { user: session.user, companyId, company, access, timeZone };
});

// Signed in, with or without a company: for the person's own security
// settings (a platform owner may belong to no company).
export const requireSignedIn = cache(async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.deactivatedAt) redirect("/sign-in");
  const companyId = session.user.companyId;
  let company: { requireTwoFactor: boolean; timeZone: string } | null = null;
  if (companyId) {
    [company] = await withTenant(companyId, (tx) =>
      tx.select({ requireTwoFactor: companies.requireTwoFactor, timeZone: companies.timeZone }).from(companies).where(eq(companies.id, companyId)),
    );
    await setCurrentActor(session.user.id);
  }
  return { user: session.user, company, timeZone: session.user.timeZone || company?.timeZone || "UTC" };
});
