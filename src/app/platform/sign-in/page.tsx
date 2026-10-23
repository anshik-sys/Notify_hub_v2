import { APIError } from "better-auth";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ipAllowed, ownerSignInAllowed, platformAccess } from "@/lib/platform";
import { clientIp, limits } from "@/lib/rate-limit";
import { Button, errorUrl, Field, firstParam, Form, Hint, Page } from "@/components/form";
import { platformSignOutAction } from "../actions";

// The platform owners' own sign-in (decided 2026-10-12), separate from the
// company app's /sign-in. Same accounts table, password, 2FA and limits, but
// only platform-only owner accounts get through.
const WRONG = "Invalid email or password"; // what Better Auth says for a wrong password

async function platformSignIn(fd: FormData) {
  "use server";
  const h = await headers();
  if (!ipAllowed(clientIp(h))) notFound();
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const limited = await limits([
    [`signin:email:${email}`, 5, 900],
    [`signin:ip:${clientIp(h)}`, 30, 900],
  ]);
  if (limited) redirect(errorUrl("/platform/sign-in", limited));
  if (!(await ownerSignInAllowed(email))) redirect(errorUrl("/platform/sign-in", WRONG));
  let twoFactor = false;
  try {
    const res = await auth.api.signInEmail({ body: { email, password: String(fd.get("password")), callbackURL: "/platform" }, headers: h });
    twoFactor = "twoFactorRedirect" in res && Boolean(res.twoFactorRedirect);
  } catch (e) {
    if (e instanceof APIError && e.body?.code === "EMAIL_NOT_VERIFIED")
      redirect(errorUrl("/platform/sign-in", "Verify your email first. We sent you a new link."));
    if (e instanceof APIError) redirect(errorUrl("/platform/sign-in", e.message));
    throw e;
  }
  redirect(twoFactor ? "/sign-in/two-factor?next=/platform" : "/platform");
}

export default async function PlatformSignIn(props: PageProps<"/platform/sign-in">) {
  const a = await platformAccess();
  if ("owner" in a || a.reason === "2fa") redirect("/platform");
  const { error, notice } = await props.searchParams;
  if (a.reason === "not-owner")
    return (
      <Page center title="Platform sign-in">
        <Hint>You’re signed in as {a.email}, which isn’t a platform account. Sign out to continue.</Hint>
        <Form action={platformSignOutAction}>
          <Button>Sign out</Button>
        </Form>
      </Page>
    );
  return (
    <Page center title="Platform sign-in" error={firstParam(error)} notice={firstParam(notice)}>
      <Form action={platformSignIn}>
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        <Button>Sign in</Button>
      </Form>
      <Hint>
        <Link href="/forgot-password?for=platform">Forgot your password?</Link>
      </Hint>
    </Page>
  );
}
