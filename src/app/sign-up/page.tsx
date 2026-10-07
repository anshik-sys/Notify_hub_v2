import { APIError } from "better-auth";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buttonClass, errorUrl, Field, firstParam, FormPage } from "../form";

async function signUp(formData: FormData) {
  "use server";
  try {
    await auth.api.signUpEmail({
      body: {
        name: String(formData.get("name")),
        email: String(formData.get("email")),
        password: String(formData.get("password")),
      },
      headers: await headers(),
    });
  } catch (e) {
    if (e instanceof APIError) redirect(errorUrl("/sign-up", e.message));
    throw e;
  }
  redirect("/onboarding");
}

export default async function SignUp(props: PageProps<"/sign-up">) {
  const error = firstParam((await props.searchParams).error);
  return (
    <FormPage title="Create an account" error={error}>
      <form action={signUp} className="flex flex-col gap-4">
        <Field label="Full name" name="name" autoComplete="name" required />
        <Field label="Work email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={8} required />
        <button className={buttonClass}>Create account</button>
      </form>
      <p className="text-sm">
        Have an account? <Link href="/sign-in" className="underline">Sign in</Link>
      </p>
    </FormPage>
  );
}
