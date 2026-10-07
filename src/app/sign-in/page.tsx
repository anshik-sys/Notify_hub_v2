import { APIError } from "better-auth";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, googleEnabled } from "@/lib/auth";
import { Button, errorUrl, Field, firstParam, Form, FormPage, Hint, safeNext } from "../form";

async function signIn(formData: FormData) {
  "use server";
  // ?next= survives the form round trip (e.g. back to an invite after signing in).
  const next = safeNext(formData.get("next"));
  const back = (message: string) =>
    errorUrl("/sign-in", message) + (next === "/" ? "" : `&next=${encodeURIComponent(next)}`);
  try {
    await auth.api.signInEmail({
      body: { email: String(formData.get("email")), password: String(formData.get("password")), callbackURL: "/" },
      headers: await headers(),
    });
  } catch (e) {
    if (e instanceof APIError && e.body?.code === "EMAIL_NOT_VERIFIED")
      redirect(back("Verify your email first. We sent you a new link."));
    if (e instanceof APIError) redirect(back(e.message));
    throw e;
  }
  redirect(next);
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
    <FormPage title="Sign in" error={firstParam(error)} notice={firstParam(notice)}>
      <Form action={signIn}>
        <input type="hidden" name="next" value={safeNext(firstParam(next))} />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        <Button>Sign in</Button>
      </Form>
      {googleEnabled && (
        <Form action={signInWithGoogle}>
          <Button>Continue with Google</Button>
        </Form>
      )}
      <Hint>
        New company? <Link href="/sign-up">Create an account</Link>
      </Hint>
    </FormPage>
  );
}
