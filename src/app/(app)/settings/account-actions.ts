"use server";

import { APIError } from "better-auth";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { errorUrl } from "@/components/form";
import { revokeMySession, setTimeZone } from "@/lib/account";
import { limits } from "@/lib/rate-limit";
import { auth } from "@/lib/auth";
import { requireMember } from "@/lib/session";

// The signed-in person's own account: no permission beyond being signed in.
// Security actions pass true to requireMember, so someone the company forces
// to set up 2FA can reach them.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const notice = (path: string, m: string): never => redirect(`${path}?notice=${encodeURIComponent(m)}`);
const SECURITY = "/settings/security";

// Password-checking actions: 5 tries per person per 15 minutes (PRD 11.1).
async function passwordLimit(userId: string, back = SECURITY) {
  const limited = await limits([[`password:user:${userId}`, 5, 900]]);
  if (limited) redirect(errorUrl(back, limited));
}

// Better Auth's own message, or a plain one.
async function call<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof APIError) redirect(errorUrl(path, e.message || "That didn't work."));
    throw e;
  }
}

export async function saveProfileAction(fd: FormData) {
  const { user } = await requireMember();
  const name = str(fd, "name").trim();
  if (!name || name.length > 100) redirect(errorUrl("/settings/profile", "Name must be 1–100 characters."));
  const tz = str(fd, "timeZone");
  const error = await setTimeZone(user.id, tz === "" ? null : tz);
  if (error) redirect(errorUrl("/settings/profile", error));
  if (name !== user.name) await call("/settings/profile", async () => auth.api.updateUser({ body: { name }, headers: await headers() }));
  notice("/settings/profile", "Saved.");
}

export async function signOutAction() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

export async function changePasswordAction(fd: FormData) {
  const { user } = await requireMember(true);
  await passwordLimit(user.id);
  const [current, next, confirm] = [str(fd, "current"), str(fd, "password"), str(fd, "confirm")];
  if (next !== confirm) redirect(errorUrl(SECURITY, "The new passwords don't match."));
  await call(SECURITY, async () =>
    auth.api.changePassword({ body: { currentPassword: current, newPassword: next, revokeOtherSessions: true }, headers: await headers() }),
  );
  notice(SECURITY, "Password changed. You've been signed out everywhere else.");
}

// Step 1: password -> secret + backup codes. They're shown once; 2FA is only
// on after step 2 proves the app has the secret.
export async function startTwoFactorAction(fd: FormData) {
  const { user } = await requireMember(true);
  await passwordLimit(user.id);
  const r = await call(SECURITY, async () =>
    auth.api.enableTwoFactor({ body: { password: str(fd, "password") }, headers: await headers() }),
  );
  if (!("totpURI" in r)) redirect(errorUrl(SECURITY, "Authenticator-app setup isn't available."));
  // ponytail: the URI + codes ride in a short-lived httpOnly cookie for the
  // next render only, rather than a table; they're already stored (encrypted)
  // by Better Auth.
  const { cookies } = await import("next/headers");
  (await cookies()).set("nh_2fa_setup", JSON.stringify({ uri: r.totpURI, codes: r.backupCodes }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: SECURITY,
    maxAge: 600,
  });
  redirect(`${SECURITY}?setup=1`);
}

export async function confirmTwoFactorAction(fd: FormData) {
  await requireMember(true);
  await call(`${SECURITY}?setup=1`, async () =>
    auth.api.verifyTOTP({ body: { code: str(fd, "code").replace(/\s+/g, "") }, headers: await headers() }),
  );
  const { cookies } = await import("next/headers");
  (await cookies()).delete({ name: "nh_2fa_setup", path: SECURITY });
  notice(SECURITY, "Two-factor is on.");
}

export async function newBackupCodesAction(fd: FormData) {
  const { user } = await requireMember(true);
  await passwordLimit(user.id);
  const r = await call(SECURITY, async () =>
    auth.api.generateBackupCodes({ body: { password: str(fd, "password") }, headers: await headers() }),
  );
  const { cookies } = await import("next/headers");
  (await cookies()).set("nh_2fa_setup", JSON.stringify({ codes: r.backupCodes }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: SECURITY,
    maxAge: 600,
  });
  redirect(`${SECURITY}?codes=1`);
}

export async function disableTwoFactorAction(fd: FormData) {
  const { user, company } = await requireMember(true);
  await passwordLimit(user.id);
  if (company.requireTwoFactor) redirect(errorUrl(SECURITY, "Your company requires two-factor, so it can't be turned off."));
  await call(SECURITY, async () => auth.api.disableTwoFactor({ body: { password: str(fd, "password") }, headers: await headers() }));
  notice(SECURITY, "Two-factor is off.");
}

export async function revokeSessionAction(fd: FormData) {
  const { user } = await requireMember(true);
  const id = str(fd, "sessionId");
  if (!id || id.length > 100) notFound();
  const error = await revokeMySession(user.id, id);
  if (error) redirect(errorUrl(SECURITY, error));
  notice(SECURITY, "Signed out that session.");
}

export async function revokeOtherSessionsAction() {
  await requireMember(true);
  await call(SECURITY, async () => auth.api.revokeOtherSessions({ headers: await headers() }));
  notice(SECURITY, "Signed out everywhere else.");
}
