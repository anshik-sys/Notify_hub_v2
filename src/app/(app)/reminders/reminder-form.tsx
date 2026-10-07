import { Button, Checkbox, CheckboxGroup, Field, Form, Hint, RadioGroup, Section, TextArea } from "@/components/form";
import { saveReminder } from "./actions";
import type { DepartmentChoice, Person } from "./form-data";
import { PeoplePicker } from "./people-picker";
import styles from "./reminder-form.module.css";

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
  departments: DepartmentChoice[];
  people: Person[];
  timeZone: string;
  defaultSender: string;
}) {
  const mine = departments.filter((d) => d.mine);
  const others = departments.filter((d) => !d.mine);
  // Teammates already show as ticks above, so the people picker only pre-fills the rest.
  const teammates = new Set(mine.flatMap((d) => d.members.map((m) => m.id)));

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

        {mine.map((d) => (
          // Your own departments: pick the whole team or tick individual teammates.
          <details key={d.id} className={styles.dept} open>
            <summary className={styles.summary}>
              {d.name} <span className={styles.count}>· your department, {d.members.length} people</span>
            </summary>
            <div className={styles.deptBody}>
              <Checkbox
                label={<strong>Everyone in {d.name}</strong>}
                name="departments"
                value={d.id}
                defaultChecked={defaults.departmentIds.includes(d.id)}
              />
              {d.members.map((m) => (
                <Checkbox
                  key={m.id}
                  label={
                    <span className={styles.person}>
                      {m.name}
                      <span className={styles.email}>{m.email}</span>
                    </span>
                  }
                  name="users"
                  value={m.id}
                  defaultChecked={defaults.userIds.includes(m.id)}
                />
              ))}
            </div>
          </details>
        ))}

        {others.length > 0 && (
          <CheckboxGroup
            legend="Other departments (need approval)"
            name="departments"
            options={others.map((d) => ({
              value: d.id,
              label: `${d.name} (${d.members.length})`,
              checked: defaults.departmentIds.includes(d.id),
            }))}
          />
        )}

        {people.length > 0 && (
          <>
            <PeoplePicker people={people} initial={defaults.userIds.filter((id) => !teammates.has(id))} />
            {/* Without JS the picker can't work: fall back to a native multi-select. */}
            <noscript>
              <label className={styles.person}>
                People
                <select name="users" multiple size={8} defaultValue={defaults.userIds}>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.email})
                    </option>
                  ))}
                </select>
              </label>
            </noscript>
          </>
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
