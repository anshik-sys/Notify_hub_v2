import { Button, CheckboxGroup, Field, firstParam, Form, Hint, Page, Section } from "@/components/form";
import { PERMISSION_GROUPS } from "@/lib/permissions";
import { platformSettingsRow, requirePlatformOwner } from "@/lib/platform";
import { platformSettingsAction } from "../actions";

// PRD 9.2: the volume alert threshold and the system Member role. The
// permission catalogue itself is code (src/lib/permissions.ts).
export default async function PlatformSettings(props: PageProps<"/platform/settings">) {
  await requirePlatformOwner();
  const s = await platformSettingsRow();
  const sp = await props.searchParams;
  return (
    <Page title="Platform settings" error={firstParam(sp.error)} notice={firstParam(sp.notice)}>
      <Form action={platformSettingsAction}>
        <Section title="Volume alert">
          <Field
            label="Alert when a company sends more than this many deliveries in 24 hours"
            name="volume"
            type="number"
            min={1}
            defaultValue={s.dailyVolumeAlert ?? ""}
            placeholder="Off"
          />
          <Hint>Platform owners get one email per company per day when it’s over. Leave empty to turn it off.</Hint>
        </Section>
        <Section title="Member role (every company)">
          <Hint>What everyone in every company can do by default. Company Admin always has everything.</Hint>
          {Object.entries(PERMISSION_GROUPS).map(([group, perms]) => (
            <CheckboxGroup
              key={group}
              legend={group}
              name="member"
              options={Object.entries(perms).map(([key, label]) => ({ value: key, label, checked: s.memberPermissions.includes(key) }))}
            />
          ))}
        </Section>
        <Button>Save</Button>
      </Form>
    </Page>
  );
}
