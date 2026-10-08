import { APIError } from "better-auth";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { clientIp, limits } from "@/lib/rate-limit";
import { auth, googleEnabled } from "@/lib/auth";
import { Button, errorUrl, Field, firstParam, Form, Page, Hint, safeNext } from "@/components/form";

async function signIn(formData: FormData) {
  "use server";
  // ?next= survives the form round trip (e.g. back to an invite after signing in).
  const next = safeNext(formData.get("next"));
  const back = (message: string) =>
    errorUrl("/sign-in", message) + (next === "/" ? "" : `&next=${encodeURIComponent(next)}`);
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const h = await headers();
  // PRD 11.1: per account (credential stuffing) and per address.
  const limited = await limits([
    [`signin:email:${email}`, 5, 900],
    [`signin:ip:${clientIp(h)}`, 30, 900],
  ]);
  if (limited) redirect(back(limited));
  let twoFactor = false;
  try {
    const res = await auth.api.signInEmail({
      body: { email: String(formData.get("email")), password: String(formData.get("password")), callbackURL: "/" },
      headers: await headers(),
    });
    // 2FA on: no session yet; a signed cookie carries the pending sign-in.
    twoFactor = "twoFactorRedirect" in res && Boolean(res.twoFactorRedirect);
  } catch (e) {
    if (e instanceof APIError && e.body?.code === "EMAIL_NOT_VERIFIED")
      redirect(back("Verify your email first. We sent you a new link."));
    if (e instanceof APIError) redirect(back(e.message));
    throw e;
  }
  redirect(twoFactor ? `/sign-in/two-factor${next === "/" ? "" : `?next=${encodeURIComponent(next)}`}` : next);
}

async function signInWithGoogle() {
  "use server";
  const { url } = await auth.api.signInSocial({ body: { provider: "google", callbackURL: "/" }, headers: await headers() });
  if (!url) redirect(errorUrl("/sign-in", "Google sign-in is unavailable."));
  redirect(url);
}

export default async function SignIn(props: PageProps<"/sign-in">) {
  const { error, notice, next } = await props.searchParams;
  return (
    <Page center title="Sign in" error={firstParam(error)} notice={firstParam(notice)}>
      <Form action={signIn}>
        <input type="hidden" name="next" value={safeNext(firstParam(next))} />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        <Button>Sign in</Button>
      </Form>
      {googleEnabled && (
        <Form action={signInWithGoogle}>
          <Button variant="secondary">Continue with Google</Button>
        </Form>
      )}
      <Hint>
        <Link href="/forgot-password">Forgot your password?</Link>
      </Hint>
      <Hint>
        New company? <Link href="/sign-up">Create an account</Link>
      </Hint>
    </Page>
  );
}
