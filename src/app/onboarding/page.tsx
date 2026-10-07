import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { createCompany } from "@/lib/onboarding";
import { buttonClass, errorUrl, Field, firstParam, FormPage, inputClass } from "../form";

const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

async function onboard(formData: FormData) {
  "use server";
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const error = await createCompany(
    session.user.id,
    session.user.email,
    String(formData.get("name")),
    String(formData.get("timeZone")),
  );
  if (error) redirect(errorUrl("/onboarding", error));
  redirect("/");
}

export default async function Onboarding(props: PageProps<"/onboarding">) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  if (session.user.companyId) redirect("/");
  const error = firstParam((await props.searchParams).error);
  return (
    <FormPage title="Set up your company" error={error}>
      <form action={onboard} className="flex flex-col gap-4">
        <Field label="Company name" name="name" autoComplete="organization" maxLength={100} required />
        <label className="flex flex-col gap-1 text-sm">
          Time zone
          <select name="timeZone" defaultValue="UTC" className={inputClass}>
            {TIME_ZONES.map((tz) => (
              <option key={tz}>{tz}</option>
            ))}
          </select>
        </label>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Your company domain is taken from your email: {session.user.email.split("@")[1]}
        </p>
        <button className={buttonClass}>Create company</button>
      </form>
    </FormPage>
  );
}
