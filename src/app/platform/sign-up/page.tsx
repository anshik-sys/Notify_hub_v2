import { APIError } from "better-auth";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ipAllowed, ownerSignInAllowed, platformAccess } from "@/lib/platform";
import { clientIp, limits } from "@/lib/rate-limit";
import { Button, errorUrl, Field, firstParam, Form, Hint, Page } from "@/components/form";

// The only self sign-up left: an address in PLATFORM_OWNER_EMAILS creates its
// platform-only account here. Every other address gets the same answer and
// nothing is created or sent, so the page doesn't reveal who is an owner.
const SENT = "If that address is a platform owner, we sent it a link to verify the account.";

async function ownerSignUp(fd: FormData) {
  "use server";
  const h = await headers();
  if (!ipAllowed(clientIp(h))) notFound();
  const limited = await limits([[`signup:ip:${clientIp(h)}`, 5, 3600]]);
  if (limited) redirect(errorUrl("/platform/sign-up", limited));
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  if (await ownerSignInAllowed(email)) {
    try {
      // auth.api skips disabledPaths, which only closes the public HTTP route.
      await auth.api.signUpEmail({ body: { name: String(fd.get("name")), email, password: String(fd.get("password")), callbackURL: "/platform" }, headers: h });
      await auth.api.sendVerificationEmail({ body: { email, callbackURL: "/platform" }, headers: h });
    } catch (e) {
      if (e instanceof APIError) redirect(errorUrl("/platform/sign-up", e.message));
      throw e;
    }
  }
  redirect(`/platform/sign-in?notice=${encodeURIComponent(SENT)}`);
}

export default async function PlatformSignUp(props: PageProps<"/platform/sign-up">) {
  const a = await platformAccess();
  if (!("reason" in a) || a.reason !== "signed-out") redirect("/platform/sign-in");
  const error = firstParam((await props.searchParams).error);
  return (
    <Page center title="Create your owner account" error={error}>
      <Form action={ownerSignUp}>
        <Field label="Full name" name="name" autoComplete="name" required />
        <Field label="Email (listed in PLATFORM_OWNER_EMAILS)" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={8} required />
        <Button>Create account</Button>
      </Form>
      <Hint>
        Use an address that isn’t in any company. <Link href="/platform/sign-in">Sign in instead</Link>
      </Hint>
    </Page>
  );
}
