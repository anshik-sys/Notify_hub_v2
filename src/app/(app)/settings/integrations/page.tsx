import { notFound, redirect } from "next/navigation";
import { Button, Checkbox, CheckboxGroup, errorUrl, Field, firstParam, Form, Hint, Page, Section, SelectField } from "@/components/form";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import {
  channelChoices,
  digestSettings,
  disconnect,
  getInstallation,
  saveDigestSettings,
  setFallbackChannel,
} from "@/lib/slack-installations";
import { listUsers } from "@/lib/users";
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

async function saveDigest(fd: FormData) {
  "use server";
  const { companyId } = await requireManager();
  const error = await saveDigestSettings(companyId, {
    enabled: fd.get("digestEnabled") === "on",
    time: String(fd.get("digestTime") ?? ""),
    channelIds: fd.getAll("digestChannels").map(String),
    userIds: fd.getAll("digestUsers").map(String),
  });
  redirect(error ? errorUrl("/settings/integrations", error) : "/settings/integrations?notice=Digest%20saved.");
}

export default async function Integrations(props: PageProps<"/settings/integrations">) {
  const { companyId, company } = await requireManager();
  const [inst, channels, digest, people] = await Promise.all([
    getInstallation(companyId),
    channelChoices(companyId),
    digestSettings(companyId),
    listUsers(companyId).then((r) => r.users.filter((u) => !u.deactivatedAt)),
  ]);
  const { error, notice } = await props.searchParams;

  return (
    <Page title="Integrations" error={firstParam(error)} notice={firstParam(notice)}>
      <Section title="Slack">
        {inst ? (
          <>
            <Hint>Connected to the {inst.teamName} workspace. Reminders can now go to Slack channels and as direct messages.</Hint>
            {!(inst.scopes.includes("files:write") && inst.scopes.includes("channels:join")) && (
              <p role="status" className={styles.warning}>
                This connection was made before some file features existed, so attachments may not reach Slack channels.{" "}
                <a href="/api/slack/install">Reconnect Slack</a> to enable them.
              </p>
            )}
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
            <Section title="Daily digest">
              <Form action={saveDigest}>
                <Checkbox label="Send a daily digest" name="digestEnabled" defaultChecked={digest?.enabled} />
                <Field label={`Time (${company.timeZone})`} name="digestTime" type="time" required defaultValue={digest?.time ?? "09:00"} />
                <Hint>Overdue tasks, and reminders going out in the next 24 hours, for the whole company.</Hint>
                {(channels ?? []).length > 0 && (
                  <CheckboxGroup
                    legend="Post to channels"
                    name="digestChannels"
                    options={(channels ?? []).map((c) => ({ value: c.id, label: `#${c.name}`, checked: digest?.channelIds.includes(c.id) }))}
                  />
                )}
                <CheckboxGroup
                  legend="Send to people (direct message)"
                  name="digestUsers"
                  options={people.map((p) => ({ value: p.id, label: `${p.name} (${p.email})`, checked: digest?.userIds.includes(p.id) }))}
                />
                <Button>Save digest</Button>
              </Form>
            </Section>
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
