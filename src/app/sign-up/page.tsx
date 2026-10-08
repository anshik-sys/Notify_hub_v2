import { APIError } from "better-auth";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { clientIp, limits } from "@/lib/rate-limit";
import { auth } from "@/lib/auth";
import { Button, errorUrl, Field, firstParam, Form, Page, Hint } from "@/components/form";

async function signUp(formData: FormData) {
  "use server";
  const limited = await limits([[`signup:ip:${clientIp(await headers())}`, 5, 3600]]);
  if (limited) redirect(errorUrl("/sign-up", limited));
  try {
    await auth.api.signUpEmail({
      body: {
        name: String(formData.get("name")),
        email: String(formData.get("email")),
        password: String(formData.get("password")),
        callbackURL: "/onboarding",
      },
      headers: await headers(),
    });
    // Better Auth answers the same for existing emails (no send, same timing).
    await auth.api.sendVerificationEmail({
      body: { email: String(formData.get("email")), callbackURL: "/onboarding" },
      headers: await headers(),
    });
  } catch (e) {
    if (e instanceof APIError) redirect(errorUrl("/sign-up", e.message));
    throw e;
  }
  redirect(`/sign-in?notice=${encodeURIComponent("Check your inbox for a link to verify your email.")}`);
}

export default async function SignUp(props: PageProps<"/sign-up">) {
  const error = firstParam((await props.searchParams).error);
  return (
    <Page center title="Create an account" error={error}>
      <Form action={signUp}>
        <Field label="Full name" name="name" autoComplete="name" required />
        <Field label="Work email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={8} required />
        <Button>Create account</Button>
      </Form>
      <Hint>
        Have an account? <Link href="/sign-in">Sign in</Link>
      </Hint>
    </Page>
  );
}
