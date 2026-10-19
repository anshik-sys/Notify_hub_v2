import { Button, Checkbox, CheckboxGroup, Field, FileField, Hint, RadioGroup, Section, SelectField, StepsForm, TextArea } from "@/components/form";
import { Icon } from "@/components/icon";
import { ACCEPT, MAX_FILES_PER_SAVE } from "@/lib/attachments";
import { formatSize } from "@/lib/format";
import type { Brand } from "@/lib/email-render";
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
  groupIds: string[];
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
  shareMine: boolean;
  shareDepartmentIds: string[];
  shareGroupIds: string[];
  shareCompany: boolean;
};

// The pages put a second submit button top right (form="…"), outside the form.
export const REMINDER_FORM_ID = "reminder-form";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Part of the When section. No client JS: all custom fields are always
// submitted, and CSS (:has) shows only the ones that apply; the server only
// reads them when "Custom…" is chosen (ruleFromForm).
function RepeatControls({ r }: { r: RepeatFields }) {
  return (
    <div className={styles.repeat}>
      <SelectField
        label="How often"
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
      <div className={styles.custom}>
        <div className={styles.moreRows}>
          <Hint>Counted from the start above.</Hint>
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
          <div className={styles.weekdays}>
            <CheckboxGroup
              legend="On these days"
              name="weekdays"
              options={WEEKDAYS.map((label, i) => ({ value: String(i), label, checked: r.weekdays.includes(String(i)) }))}
            />
          </div>
          <div className={styles.monthlyBy}>
            <RadioGroup
              legend="On"
              name="monthlyBy"
              value={r.monthlyBy}
              options={[
                { value: "day", label: "The same date, e.g. the 15th (31st → last day in short months)" },
                { value: "weekday", label: "The same weekday, e.g. the 3rd Tuesday" },
                { value: "last", label: "The last of that weekday, e.g. the last Friday" },
              ]}
            />
          </div>
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
          <div className={styles.endUntil}>
            <Field label="End date" name="until" type="date" defaultValue={r.until} />
          </div>
          <div className={styles.endCount}>
            <Field label="Times" name="count" type="number" inputMode="numeric" min={1} max={500} defaultValue={r.count} />
          </div>
        </div>
      </div>
    </div>
  );
}

const LINK_ROWS = 10;

function LinkRow({ index, link }: { index: number; link?: { label: string; url: string } }) {
  return (
    <div className={styles.linkRow}>
      <Field label={`Link ${index + 1}`} name="linkUrl" type="url" inputMode="url" placeholder="https://…" defaultValue={link?.url} />
      <Field label="Label" name="linkLabel" maxLength={100} defaultValue={link?.label} />
    </div>
  );
}

export function ReminderForm({
  defaults,
  departments,
  people,
  groups,
  timeZone,
  defaultSender,
  slackChannels,
  attachments = [],
  brand,
  nextLabel,
}: {
  defaults: ReminderDefaults;
  departments: DepartmentChoice[];
  people: Person[];
  groups: { id: string; name: string; members: number }[];
  timeZone: string;
  defaultSender: string;
  /** The company's public Slack channels; null when Slack isn't connected. */
  slackChannels: { id: string; name: string }[] | null;
  /** Edit: files already on the reminder. */
  attachments?: { id: string; fileName: string; size: number }[];
  /** The company's name and logo, for the email preview's header. */
  brand?: Brand;
  /** Edit of a scheduled series: its next occurrence, for "only the next one" (PRD 5.6). */
  nextLabel?: string;
}) {
  const mine = departments.filter((d) => d.mine);
  const others = departments.filter((d) => !d.mine);
  // Teammates already show as ticks above, so the people picker only pre-fills the rest.
  const teammates = new Set(mine.flatMap((d) => d.members.map((m) => m.id)));

  // Your own departments are covered by "My departments"; one already shared
  // by id (an older reminder) stays listed so saving an edit keeps it.
  const shareable = departments.filter((d) => !d.mine || defaults.shareDepartmentIds.includes(d.id));
  const widerInUse = Boolean(
    defaults.departmentIds.some((id) => others.some((d) => d.id === id)) || defaults.groupIds.length || defaults.emails.trim(),
  );
  // Names only what the fold holds, e.g. "Other departments, groups and emails".
  const widerParts = [others.length > 0 && "other departments", groups.length > 0 && "groups", "emails"].filter(Boolean) as string[];
  const widerTitle = widerParts.join(", ").replace(/, ([^,]*)$/, " and $1").replace(/^./, (c) => c.toUpperCase());
  // "More options" opens by itself when editing a reminder that uses one of them.
  const usesOptions = Boolean(
    defaults.tags ||
      defaults.links.length ||
      attachments.length ||
      defaults.shareMine ||
      defaults.shareDepartmentIds.length ||
      defaults.shareGroupIds.length ||
      defaults.shareCompany ||
      defaults.senderName,
  );

  return (
    <StepsForm
      id={REMINDER_FORM_ID}
      action={saveReminder}
      aside={
        // Inside the form: the preview reads the fields as you type.
        <Section title="Preview">
          <ReminderPreview defaultSender={defaultSender} timeZone={timeZone} brand={brand} />
        </Section>
      }
    >
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}

      <Section title="What" step={1}>
        <Hint>
          Fields marked <span aria-hidden="true">*</span> are required. Everything else can be left as it is.
        </Hint>
        <Field label="Title" name="title" maxLength={200} required defaultValue={defaults.title} />
        <TextArea label="Description" name="description" maxLength={5000} defaultValue={defaults.description} />
      </Section>

      <Section title="Who" step={2} required>
        <Hint>
          Sending outside your departments, to the whole company or to outside emails needs an admin’s approval first.
        </Hint>
        {/* The quick picks on one row: your department(s) first, then the company. */}
        <div className={styles.quickPicks}>
          {mine.map((d) => (
            <Checkbox
              key={d.id}
              label={<strong>Everyone in {d.name}</strong>}
              name="departments"
              value={d.id}
              defaultChecked={defaults.departmentIds.includes(d.id)}
            />
          ))}
          <Checkbox label="Everyone in the company" name="company" defaultChecked={defaults.company} />
        </div>

        {mine.map((d) => (
          // Or tick individual teammates (open when editing a pick from it).
          <details key={d.id} className={styles.dept} open={d.members.some((m) => defaults.userIds.includes(m.id))}>
            <summary className={styles.summary}>
              Pick people in {d.name}&nbsp;<span className={styles.count}>({d.members.length})</span>
            </summary>
            <div className={styles.deptBody}>
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

        {/* The wider recipients: folded, open when editing one that's in use. */}
        <details className={styles.more} open={widerInUse}>
          <summary className={styles.summary}>{widerTitle}</summary>
          <div className={styles.moreRows}>
            {others.length > 0 && (
              <CheckboxGroup
                legend="Other departments"
                name="departments"
                options={others.map((d) => ({
                  value: d.id,
                  label: `${d.name} (${d.members.length})`,
                  checked: defaults.departmentIds.includes(d.id),
                }))}
              />
            )}
            {groups.length > 0 && (
              <CheckboxGroup
                legend="Groups"
                name="groups"
                options={groups.map((g) => ({
                  value: g.id,
                  label: `${g.name} (${g.members})`,
                  checked: defaults.groupIds.includes(g.id),
                }))}
              />
            )}
            <TextArea
              label="Other emails (comma or one per line)"
              name="emails"
              inputMode="email"
              rows={3}
              defaultValue={defaults.emails}
            />
          </div>
        </details>
      </Section>

      <Section title="How" step={3} required>
        <div className={styles.channels}>
          <CheckboxGroup
            legend="Send by"
            hideLegend
            name="channels"
            options={[
              { value: "email", label: "Email", checked: defaults.channels.includes("email") },
              ...(slackChannels
                ? [{ value: "slack", label: "Slack (direct messages, and any channels picked below)", checked: defaults.channels.includes("slack") }]
                : []),
            ]}
          />
          {slackChannels && slackChannels.length > 0 && (
            // Shown once Slack is ticked (CSS :has); always submitted, and only
            // read when Slack is a channel.
            <div className={styles.slackPicks}>
              <CheckboxGroup
                legend="Also post in these Slack channels"
                name="slackChannels"
                options={slackChannels.map((c) => ({ value: c.id, label: `#${c.name}`, checked: defaults.slackChannelIds.includes(c.id) }))}
              />
              <Hint>Posting in a channel needs an admin’s approval, unless you’re an admin.</Hint>
            </div>
          )}
        </div>
        {!slackChannels && <Hint>Slack isn’t connected. An admin can connect it under Integrations.</Hint>}
      </Section>

      <Section title="When" step={4} required>
        {nextLabel && (
          <>
            <RadioGroup
              legend="Change"
              name="scope"
              value="all"
              options={[
                { value: "all", label: "This and all future ones" },
                { value: "one", label: `Only the next one (${nextLabel})` },
              ]}
            />
            <Hint>
              Only the next one: it becomes a separate one-time reminder at the time below, and the series skips that date. The repeat
              settings are ignored.
            </Hint>
          </>
        )}
        <div className={styles.when}>
          <RadioGroup
            legend="When to send"
            hideLegend
            name="when"
            value={defaults.when}
            options={[
              { value: "now", label: "Now" },
              { value: "later", label: "At a set time" },
            ]}
          />
          <div className={styles.sendAt}>
            <Field label={`Date and time (${timeZone})`} name="sendAt" type="datetime-local" defaultValue={defaults.sendAtLocal} />
            <Hint>For a repeating reminder, this is the first one.</Hint>
          </div>
          <RepeatControls r={defaults.repeat} />
        </div>
      </Section>

      <Section title="Task" step={5}>
        <div className={styles.task}>
          <Checkbox label="This is a task: everyone must mark it done" name="isTask" defaultChecked={defaults.isTask} />
          <div className={styles.due}>
            <Field label={`Due (${timeZone})`} name="due" type="datetime-local" defaultValue={defaults.dueLocal} />
            <Hint>Anyone not done by then gets a reminder every day until they are.</Hint>
          </div>
        </div>
      </Section>

      {/* Native disclosure, no client JS: the rarely needed settings. */}
      <details className={styles.options} open={usesOptions}>
        <summary className={styles.optionsSummary}>
          <span className={styles.optionsText}>
            More options
            <span className={styles.optionsHint}>Tags, links, attachments, sharing, sender name</span>
          </span>
          <span className={styles.optionsChevron}>
            <Icon name="chevron" size={18} />
          </span>
        </summary>
        <div className={styles.optionsBody}>
          <Field label="Tags, comma separated" name="tags" maxLength={400} placeholder="payroll, q3" defaultValue={defaults.tags} />

          <div className={styles.block}>
            <h3 className={styles.blockTitle}>Links</h3>
            <LinkRow index={0} link={defaults.links[0]} />
            <details className={styles.more} open={defaults.links.length > 1}>
              <summary className={styles.summary}>More links</summary>
              <div className={styles.moreRows}>
                {Array.from({ length: LINK_ROWS - 1 }, (_, i) => (
                  <LinkRow key={i + 1} index={i + 1} link={defaults.links[i + 1]} />
                ))}
              </div>
            </details>
          </div>

          <div className={styles.block}>
            <h3 className={styles.blockTitle}>Attachments</h3>
            {attachments.length > 0 && (
              <CheckboxGroup
                legend="Attached (tick to remove)"
                name="removeAttachments"
                options={attachments.map((a) => ({ value: a.id, label: `${a.fileName} (${formatSize(a.size)})` }))}
              />
            )}
            <FileField label="Add files" name="files" multiple accept={ACCEPT} />
            <Hint>PDF, Office, CSV/TXT, images or ZIP. 10 MB each, up to {MAX_FILES_PER_SAVE} at a time.</Hint>
          </div>

          <div className={styles.block}>
            <h3 className={styles.blockTitle}>Who can see it</h3>
            <Hint>You, your managers, admins and recipients can always see it. Share it so others can view it too.</Hint>
            {mine.length > 0 && (
              <Checkbox label={`My departments (${mine.map((d) => d.name).join(", ")})`} name="shareMine" defaultChecked={defaults.shareMine} />
            )}
            {shareable.length > 0 && (
              <CheckboxGroup
                legend="Other departments"
                name="shareDepartments"
                options={shareable.map((d) => ({ value: d.id, label: d.name, checked: defaults.shareDepartmentIds.includes(d.id) }))}
              />
            )}
            {groups.length > 0 && (
              <CheckboxGroup
                legend="Groups"
                name="shareGroups"
                options={groups.map((g) => ({ value: g.id, label: g.name, checked: defaults.shareGroupIds.includes(g.id) }))}
              />
            )}
            <Checkbox label="Share with the whole company" name="shareCompany" defaultChecked={defaults.shareCompany} />
          </div>

          <Field label="Sender name" name="senderName" maxLength={100} placeholder={defaultSender} defaultValue={defaults.senderName} />
        </div>
      </details>

      <Button>{defaults.id ? "Save reminder" : "Create reminder"}</Button>
    </StepsForm>
  );
}
