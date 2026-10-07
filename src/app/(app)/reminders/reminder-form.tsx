import { Button, Checkbox, CheckboxGroup, Field, Form, Hint, RadioGroup, Section, TextArea } from "@/components/form";
import { saveReminder } from "./actions";
import styles from "./reminder-form.module.css";

type Option = { value: string; label: string };
export type ReminderDefaults = {
  id?: string;
  title: string;
  description: string;
  senderName: string;
  links: { label: string; url: string }[];
  company: boolean;
  departmentIds: string[];
  userIds: string[];
  emails: string;
  when: "now" | "later";
  sendAtLocal: string;
};

const LINK_ROWS = 10;

function LinkRow({ index, link }: { index: number; link?: { label: string; url: string } }) {
  return (
    <div className={styles.linkRow}>
      <Field label={`Link ${index + 1}`} name="linkUrl" type="url" inputMode="url" placeholder="https://…" defaultValue={link?.url} />
      <Field label="Label (optional)" name="linkLabel" maxLength={100} defaultValue={link?.label} />
    </div>
  );
}

export function ReminderForm({
  defaults,
  departments,
  people,
  timeZone,
  defaultSender,
}: {
  defaults: ReminderDefaults;
  departments: Option[];
  people: Option[];
  timeZone: string;
  defaultSender: string;
}) {
  return (
    <Form action={saveReminder}>
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}

      <Field label="Title" name="title" maxLength={200} required defaultValue={defaults.title} />
      <TextArea label="Description (optional)" name="description" maxLength={5000} defaultValue={defaults.description} />

      <Section title="Links">
        <LinkRow index={0} link={defaults.links[0]} />
        {/* Native disclosure: no client JS for the other nine rows. */}
        <details className={styles.more} open={defaults.links.length > 1}>
          <summary className={styles.summary}>More links</summary>
          <div className={styles.moreRows}>
            {Array.from({ length: LINK_ROWS - 1 }, (_, i) => (
              <LinkRow key={i + 1} index={i + 1} link={defaults.links[i + 1]} />
            ))}
          </div>
        </details>
      </Section>

      <Section title="Recipients">
        <Hint>
          Sending outside your departments, to the whole company or to outside emails needs an admin’s approval first.
        </Hint>
        <Checkbox label="Everyone in the company" name="company" defaultChecked={defaults.company} />
        {departments.length > 0 && (
          <CheckboxGroup
            legend="Departments"
            name="departments"
            options={departments.map((d) => ({ ...d, checked: defaults.departmentIds.includes(d.value) }))}
          />
        )}
        {people.length > 0 && (
          <CheckboxGroup
            legend="People"
            name="users"
            options={people.map((p) => ({ ...p, checked: defaults.userIds.includes(p.value) }))}
          />
        )}
        <TextArea
          label="Other emails (comma or one per line)"
          name="emails"
          inputMode="email"
          rows={3}
          defaultValue={defaults.emails}
        />
      </Section>

      <Section title="When">
        <RadioGroup
          legend="Send"
          name="when"
          value={defaults.when}
          options={[
            { value: "now", label: "Now" },
            { value: "later", label: "At a set time" },
          ]}
        />
        <Field label={`Date and time (${timeZone})`} name="sendAt" type="datetime-local" defaultValue={defaults.sendAtLocal} />
      </Section>

      <Field label="Sender name" name="senderName" maxLength={100} placeholder={defaultSender} defaultValue={defaults.senderName} />

      <Button>{defaults.id ? "Save reminder" : "Create reminder"}</Button>
    </Form>
  );
}
