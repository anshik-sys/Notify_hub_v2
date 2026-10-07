import { Button, Checkbox, CheckboxGroup, Field, Form, Hint, RadioGroup, Section, SelectField, TextArea } from "@/components/form";
import { ACCEPT, MAX_FILES_PER_SAVE } from "@/lib/attachments";
import { formatSize } from "@/lib/format";
import type { RepeatFields } from "@/lib/recurrence";
import { saveReminder } from "./actions";
import type { DepartmentChoice, Person } from "./form-data";
import { PeoplePicker } from "./people-picker";
import { ReminderPreview } from "./preview";
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
  repeat: RepeatFields;
  isTask: boolean;
  dueLocal: string;
  channels: string[];
  slackChannelIds: string[];
  tags: string;
};

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// No client JS: all custom fields are always submitted; the server only reads
// them when "Custom…" is chosen (ruleFromForm).
function RepeatSection({ r }: { r: RepeatFields }) {
  return (
    <Section title="Repeat">
      <SelectField
        label="Repeat"
        name="repeat"
        defaultValue={r.repeat}
        options={[
          { value: "none", label: "Does not repeat" },
          { value: "daily", label: "Every day" },
          { value: "weekdays", label: "Every weekday (Mon–Fri)" },
          { value: "weekly", label: "Every week, on the start day" },
          { value: "monthly", label: "Every month, on the start date" },
          { value: "yearly", label: "Every year, on the start date" },
          { value: "custom", label: "Custom…" },
        ]}
      />
      <details className={styles.more} open={r.repeat === "custom"}>
        <summary className={styles.summary}>Custom repeat</summary>
        <div className={styles.moreRows}>
          <Hint>Used when Repeat is “Custom…”. Dates are counted from the start above.</Hint>
          <div className={styles.everyRow}>
            <Field label="Every" name="every" type="number" inputMode="numeric" min={1} max={99} defaultValue={r.every} />
            <SelectField
              label="Unit"
              name="unit"
              defaultValue={r.unit}
              options={[
                { value: "day", label: "days" },
                { value: "week", label: "weeks" },
                { value: "month", label: "months" },
                { value: "year", label: "years" },
              ]}
            />
          </div>
          <CheckboxGroup
            legend="On these days (weeks)"
            name="weekdays"
            options={WEEKDAYS.map((label, i) => ({ value: String(i), label, checked: r.weekdays.includes(String(i)) }))}
          />
          <RadioGroup
            legend="On (months)"
            name="monthlyBy"
            value={r.monthlyBy}
            options={[
              { value: "day", label: "The same date, e.g. the 15th (31st → last day in short months)" },
              { value: "weekday", label: "The same weekday, e.g. the 3rd Tuesday" },
              { value: "last", label: "The last of that weekday, e.g. the last Friday" },
            ]}
          />
          <RadioGroup
            legend="Ends"
            name="ends"
            value={r.ends}
            options={[
              { value: "never", label: "Never" },
              { value: "until", label: "On a date" },
              { value: "count", label: "After a number of times" },
            ]}
          />
          <Field label="End date (if ending on a date)" name="until" type="date" defaultValue={r.until} />
          <Field
            label="Times (if ending after a number)"
            name="count"
            type="number"
            inputMode="numeric"
            min={1}
            max={500}
            defaultValue={r.count}
          />
        </div>
      </details>
    </Section>
  );
}

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
  slackChannels,
  attachments = [],
}: {
  defaults: ReminderDefaults;
  departments: DepartmentChoice[];
  people: Person[];
  timeZone: string;
  defaultSender: string;
  /** The company's public Slack channels; null when Slack isn't connected. */
  slackChannels: { id: string; name: string }[] | null;
  /** Edit: files already on the reminder. */
  attachments?: { id: string; fileName: string; size: number }[];
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
      <Field label="Tags (optional, comma separated)" name="tags" maxLength={400} placeholder="payroll, q3" defaultValue={defaults.tags} />

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

      <Section title="Channels">
        <CheckboxGroup
          legend="Send by"
          name="channels"
          options={[
            { value: "email", label: "Email", checked: defaults.channels.includes("email") },
            ...(slackChannels
              ? [{ value: "slack", label: "Slack (direct messages, and any channels picked below)", checked: defaults.channels.includes("slack") }]
              : []),
          ]}
        />
        {!slackChannels && <Hint>Slack isn’t connected. An admin can connect it under Integrations.</Hint>}
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
        {slackChannels && slackChannels.length > 0 && (
          <CheckboxGroup
            legend="Slack channels (need approval unless you’re an admin)"
            name="slackChannels"
            options={slackChannels.map((c) => ({ value: c.id, label: `#${c.name}`, checked: defaults.slackChannelIds.includes(c.id) }))}
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
        <Hint>For a repeating reminder, this is the first time; later ones follow from it.</Hint>
      </Section>

      <Section title="Attachments">
        {attachments.length > 0 && (
          <CheckboxGroup
            legend="Attached (tick to remove)"
            name="removeAttachments"
            options={attachments.map((a) => ({ value: a.id, label: `${a.fileName} (${formatSize(a.size)})` }))}
          />
        )}
        <label className={styles.fileField}>
          Add files (up to {MAX_FILES_PER_SAVE} at a time, 10 MB each)
          <input type="file" name="files" multiple accept={ACCEPT} className={styles.fileInput} />
        </label>
        <Hint>PDF, Office documents, CSV/TXT, images and ZIP. Emails carry up to 20 MB of files; larger ones are linked instead.</Hint>
      </Section>

      <RepeatSection r={defaults.repeat} />

      <Section title="Task">
        <Checkbox label="This is a task: everyone must mark it done" name="isTask" defaultChecked={defaults.isTask} />
        <Field label={`Due (${timeZone})`} name="due" type="datetime-local" defaultValue={defaults.dueLocal} />
        <Hint>
          Anyone not done by then gets a reminder every day until they are. For repeating tasks, each one is due the
          same time after it’s sent.
        </Hint>
      </Section>

      <Field label="Sender name" name="senderName" maxLength={100} placeholder={defaultSender} defaultValue={defaults.senderName} />

      <Section title="Preview">
        <ReminderPreview defaultSender={defaultSender} timeZone={timeZone} />
      </Section>

      <Button>{defaults.id ? "Save reminder" : "Create reminder"}</Button>
    </Form>
  );
}
