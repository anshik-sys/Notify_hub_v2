import { notFound, redirect } from "next/navigation";
import { Button, errorUrl, Field, firstParam, Form, Hint, Page } from "@/components/form";
import { followUpTime, setFollowUpTime } from "@/lib/company";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";

async function save(fd: FormData) {
  "use server";
  const { companyId, access } = await requireMember();
  if (!can(access, "company.edit")) notFound();
  const error = await setFollowUpTime(companyId, String(fd.get("followUpTime") ?? ""));
  redirect(error ? errorUrl("/settings/company", error) : "/settings/company?notice=Saved.");
}

export default async function CompanySettings(props: PageProps<"/settings/company">) {
  const { companyId, company, access } = await requireMember();
  if (!can(access, "company.edit")) notFound();
  const { error, notice } = await props.searchParams;

  return (
    <Page title="Company settings" back={{ href: "/", label: "Home" }} error={firstParam(error)} notice={firstParam(notice)}>
      <Form action={save}>
        <Field
          label={`Daily task follow-up time (${company.timeZone})`}
          name="followUpTime"
          type="time"
          required
          defaultValue={await followUpTime(companyId)}
        />
        <Hint>Everyone with an overdue task gets one reminder a day at this time until they mark it done.</Hint>
        <Button>Save</Button>
      </Form>
    </Page>
  );
}
