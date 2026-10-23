import { Button, CheckboxGroup, Form, Hint, Page, Section, firstParam } from "@/components/form";
import { getMutes, MUTABLE } from "@/lib/notifications";
import { vapidPublicKey } from "@/lib/push";
import { requireMember } from "@/lib/session";
import { PushToggle } from "./push-toggle";
import { savePreferencesAction } from "../actions";

const CHANNEL_LABEL = { email: "Email", slack: "Slack DM", push: "Browser push" } as const;

export default async function NotificationPreferences(props: PageProps<"/notifications/preferences">) {
  const { user, companyId } = await requireMember();
  const mutes = await getMutes(companyId, user.id);
  const notice = firstParam((await props.searchParams).notice);

  return (
    <Page title="Notification preferences" back={{ href: "/notifications", label: "Notifications" }} notice={notice}>
      {/* PRD 14.7: per browser, so outside the saved preferences below. */}
      <Section title="Push notifications in this browser">
        {vapidPublicKey() ? <PushToggle vapidKey={vapidPublicKey()!} /> : <Hint>Push isn’t set up on this server yet.</Hint>}
      </Section>
      <Form action={savePreferencesAction}>
        <Hint>
          Everything always shows in Notifications. Choose where else you hear about it. Reminders and tasks sent to you
          always arrive the way the sender chose.
        </Hint>
        {MUTABLE.map((m) => (
          <Section key={m.event} title={m.label}>
            <CheckboxGroup
              legend="Also send by"
              name="on"
              options={m.channels.map((c) => ({
                value: `${m.event}:${c}`,
                label: CHANNEL_LABEL[c],
                checked: !mutes.has(`${m.event}:${c}`),
              }))}
            />
          </Section>
        ))}
        <Button>Save</Button>
      </Form>
    </Page>
  );
}
