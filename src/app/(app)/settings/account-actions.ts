"use server";

import { APIError } from "better-auth";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { errorUrl } from "@/components/form";
import { revokeMySession, setTimeZone } from "@/lib/account";
import { limits } from "@/lib/rate-limit";
import { auth } from "@/lib/auth";
import { requireMember, requireSignedIn } from "@/lib/session";

// The signed-in person's own account: no permission beyond being signed in.
// Security actions only need a session (requireSignedIn): someone the company
// forces to set up 2FA, or a platform owner with no company, must reach them.
// They return to whichever security page posted them (in or outside the app).
// (Was: security actions pass true to requireMember, so someone the company forces
// to set up 2FA can reach them.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const notice = (path: string, m: string): never => redirect(`${path}?notice=${encodeURIComponent(m)}`);
const SECURITY = "/settings/security";
const PAGES = [SECURITY, "/account/security"];
const base = (fd: FormData) => (PAGES.includes(String(fd.get("base"))) ? String(fd.get("base")) : SECURITY);

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
  const S = base(fd);
  const { user } = await requireSignedIn();
  await passwordLimit(user.id, S);
  const [current, next, confirm] = [str(fd, "current"), str(fd, "password"), str(fd, "confirm")];
  if (next !== confirm) redirect(errorUrl(S, "The new passwords don't match."));
  await call(S, async () =>
    auth.api.changePassword({ body: { currentPassword: current, newPassword: next, revokeOtherSessions: true }, headers: await headers() }),
  );
  notice(S, "Password changed. You've been signed out everywhere else.");
}

// Step 1: password -> secret + backup codes. They're shown once; 2FA is only
// on after step 2 proves the app has the secret.
export async function startTwoFactorAction(fd: FormData) {
  const S = base(fd);
  const { user } = await requireSignedIn();
  await passwordLimit(user.id, S);
  const r = await call(S, async () =>
    auth.api.enableTwoFactor({ body: { password: str(fd, "password") }, headers: await headers() }),
  );
  if (!("totpURI" in r)) redirect(errorUrl(S, "Authenticator-app setup isn't available."));
  // ponytail: the URI + codes ride in a short-lived httpOnly cookie for the
  // next render only, rather than a table; they're already stored (encrypted)
  // by Better Auth.
  const { cookies } = await import("next/headers");
  (await cookies()).set("nh_2fa_setup", JSON.stringify({ uri: r.totpURI, codes: r.backupCodes }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: S,
    maxAge: 600,
  });
  redirect(`${S}?setup=1`);
}

export async function confirmTwoFactorAction(fd: FormData) {
  const S = base(fd);
  await requireSignedIn();
  await call(`${S}?setup=1`, async () =>
    auth.api.verifyTOTP({ body: { code: str(fd, "code").replace(/\s+/g, "") }, headers: await headers() }),
  );
  const { cookies } = await import("next/headers");
  (await cookies()).delete({ name: "nh_2fa_setup", path: S });
  notice(S, "Two-factor is on.");
}

export async function newBackupCodesAction(fd: FormData) {
  const S = base(fd);
  const { user } = await requireSignedIn();
  await passwordLimit(user.id, S);
  const r = await call(S, async () =>
    auth.api.generateBackupCodes({ body: { password: str(fd, "password") }, headers: await headers() }),
  );
  const { cookies } = await import("next/headers");
  (await cookies()).set("nh_2fa_setup", JSON.stringify({ codes: r.backupCodes }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: S,
    maxAge: 600,
  });
  redirect(`${S}?codes=1`);
}

export async function disableTwoFactorAction(fd: FormData) {
  const S = base(fd);
  const { user, company } = await requireSignedIn();
  await passwordLimit(user.id, S);
  if (company?.requireTwoFactor) redirect(errorUrl(S, "Your company requires two-factor, so it can't be turned off."));
  await call(S, async () => auth.api.disableTwoFactor({ body: { password: str(fd, "password") }, headers: await headers() }));
  notice(S, "Two-factor is off.");
}

export async function revokeSessionAction(fd: FormData) {
  const S = base(fd);
  const { user } = await requireSignedIn();
  const id = str(fd, "sessionId");
  if (!id || id.length > 100) notFound();
  const error = await revokeMySession(user.id, id);
  if (error) redirect(errorUrl(S, error));
  notice(S, "Signed out that session.");
}

export async function revokeOtherSessionsAction(fd: FormData) {
  const S = base(fd);
  await requireSignedIn();
  await call(S, async () => auth.api.revokeOtherSessions({ headers: await headers() }));
  notice(S, "Signed out everywhere else.");
}
