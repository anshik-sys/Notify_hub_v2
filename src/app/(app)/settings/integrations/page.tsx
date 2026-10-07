import { notFound, redirect } from "next/navigation";
import { Button, errorUrl, firstParam, Form, Hint, Page, Section, SelectField } from "@/components/form";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { channelChoices, disconnect, getInstallation, setFallbackChannel } from "@/lib/slack-installations";
import styles from "./page.module.css";

async function requireManager() {
  const m = await requireMember();
  if (!can(m.access, "company.manage_integrations")) notFound();
  return m;
}

async function disconnectSlack() {
  "use server";
  const { companyId } = await requireManager();
  await disconnect(companyId);
  redirect("/settings/integrations?notice=" + encodeURIComponent("Slack disconnected."));
}

async function saveFallback(fd: FormData) {
  "use server";
  const { companyId } = await requireManager();
  const error = await setFallbackChannel(companyId, String(fd.get("fallback") ?? "") || null);
  redirect(error ? errorUrl("/settings/integrations", error) : "/settings/integrations?notice=Saved.");
}

export default async function Integrations(props: PageProps<"/settings/integrations">) {
  const { companyId } = await requireManager();
  const [inst, channels] = await Promise.all([getInstallation(companyId), channelChoices(companyId)]);
  const { error, notice } = await props.searchParams;

  return (
    <Page title="Integrations" error={firstParam(error)} notice={firstParam(notice)}>
      <Section title="Slack">
        {inst ? (
          <>
            <Hint>Connected to the {inst.teamName} workspace. Reminders can now go to Slack channels and as direct messages.</Hint>
            <Form action={saveFallback}>
              <SelectField
                label="Fallback channel"
                name="fallback"
                defaultValue={inst.fallbackChannelId ?? ""}
                options={[{ value: "", label: "None" }, ...(channels ?? []).map((c) => ({ value: c.id, label: `#${c.name}` }))]}
              />
              <Hint>When someone can’t be reached by direct message (no Slack account with their email), the reminder is posted here instead.</Hint>
              <Button>Save</Button>
            </Form>
            <form action={disconnectSlack}>
              <Button variant="secondary">Disconnect Slack</Button>
            </form>
          </>
        ) : (
          <>
            <Hint>Connect your company’s Slack workspace to send reminders to channels and as direct messages.</Hint>
            {/* A plain link, not next/link: this is an API route that redirects to Slack. */}
            <a href="/api/slack/install" className={styles.connect}>
              Add to Slack
            </a>
          </>
        )}
      </Section>
    </Page>
  );
}
