import { APIError } from "better-auth";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, googleEnabled } from "@/lib/auth";
import { buttonClass, errorUrl, Field, firstParam, FormPage } from "../form";

async function signIn(formData: FormData) {
  "use server";
  try {
    await auth.api.signInEmail({
      body: { email: String(formData.get("email")), password: String(formData.get("password")) },
      headers: await headers(),
    });
  } catch (e) {
    if (e instanceof APIError) redirect(errorUrl("/sign-in", e.message));
    throw e;
  }
  redirect("/");
}

async function signInWithGoogle() {
  "use server";
  const { url } = await auth.api.signInSocial({ body: { provider: "google", callbackURL: "/" }, headers: await headers() });
  if (!url) redirect(errorUrl("/sign-in", "Google sign-in is unavailable."));
  redirect(url);
}

export default async function SignIn(props: PageProps<"/sign-in">) {
  const error = firstParam((await props.searchParams).error);
  return (
    <FormPage title="Sign in" error={error}>
      <form action={signIn} className="flex flex-col gap-4">
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        <button className={buttonClass}>Sign in</button>
      </form>
      {googleEnabled && (
        <form action={signInWithGoogle}>
          <button className={buttonClass}>Continue with Google</button>
        </form>
      )}
      <p className="text-sm">
        New company? <Link href="/sign-up" className="underline">Create an account</Link>
      </p>
    </FormPage>
  );
}
