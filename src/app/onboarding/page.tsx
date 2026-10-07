import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { createCompany } from "@/lib/onboarding";
import { Button, errorUrl, Field, firstParam, Form, FormPage, Hint, SelectField } from "../form";

const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

async function onboard(formData: FormData) {
  "use server";
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const error = await createCompany(session.user, String(formData.get("name")), String(formData.get("timeZone")));
  if (error) redirect(errorUrl("/onboarding", error));
  redirect("/");
}

export default async function Onboarding(props: PageProps<"/onboarding">) {
  const error = firstParam((await props.searchParams).error);
  const session = await auth.api.getSession({ headers: await headers() });
  // A failed verification link lands here with ?error=TOKEN_EXPIRED etc. and no session.
  if (!session) redirect(error ? errorUrl("/sign-in", "That link is invalid or expired. Sign in to get a new one.") : "/sign-in");
  if (session.user.companyId) redirect("/");
  return (
    <FormPage title="Set up your company" error={error}>
      <Form action={onboard}>
        <Field label="Company name" name="name" autoComplete="organization" maxLength={100} required />
        <SelectField label="Time zone" name="timeZone" defaultValue="UTC" options={TIME_ZONES} />
        <Hint>Your company domain is taken from your email: {session.user.email.split("@")[1]}</Hint>
        <Button>Create company</Button>
      </Form>
    </FormPage>
  );
}
