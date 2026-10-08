import { notFound } from "next/navigation";
import { FilterBar, Pager } from "@/components/filters";
import { Field, LinkButton, Page, SelectField } from "@/components/form";
import { Badge, Muted, Table } from "@/components/table";
import { REMINDER_STATUSES } from "@/db/schema";
import { can } from "@/lib/permissions";
import { describe } from "@/lib/recurrence";
import { isDelayed, STATUS_LABELS, statusLabel, statusTone } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";
import { filterUrl, PAGE_SIZE, parseFilters, searchReminders, SORTS, visibleCreators } from "@/lib/views";
import styles from "./page.module.css";

const any = { value: "", label: "Any" };

export default async function Reminders(props: PageProps<"/reminders">) {
  const { user, companyId, access, timeZone } = await requireMember();
  if (!can(access, "reminders.create") && !can(access, "reminders.view_all")) notFound();
  const viewer = { id: user.id, access };
  const f = parseFilters(await props.searchParams);
  const [{ rows, total }, creators] = await Promise.all([
    searchReminders(companyId, viewer, timeZone, f),
    visibleCreators(companyId, viewer),
  ]);
  const filtered = filterUrl({ ...f, page: 1 }) !== "/reminders";

  return (
    <Page
      title="Reminders"
      actions={can(access, "reminders.create") && <LinkButton href="/reminders/new">New reminder</LinkButton>}
    >
      <FilterBar action="/reminders" clearHref={filtered ? "/reminders" : undefined}>
        <Field label="Search" name="q" type="search" placeholder="Title, description, recipient, ID or tag" defaultValue={f.q} />
        <SelectField
          label="Show"
          name="show"
          defaultValue={f.show}
          options={[
            { value: "all", label: "All I can see" },
            { value: "oversee", label: "Mine and my teams’" },
            { value: "mine", label: "Created by me" },
            { value: "shared", label: "Shared with me" },
            { value: "received", label: "Sent to me" },
          ]}
        />
        <SelectField
          label="Status"
          name="status"
          defaultValue={f.status ?? ""}
          options={[any, ...REMINDER_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))]}
        />
        <SelectField
          label="Channel"
          name="channel"
          defaultValue={f.channel ?? ""}
          options={[any, { value: "email", label: "Email" }, { value: "slack", label: "Slack" }]}
        />
        <SelectField
          label="Repeats"
          name="repeat"
          defaultValue={f.repeat ?? ""}
          options={[
            any,
            { value: "none", label: "One-time" },
            { value: "daily", label: "Daily" },
            { value: "weekly", label: "Weekly" },
            { value: "monthly", label: "Monthly" },
            { value: "yearly", label: "Yearly" },
          ]}
        />
        <SelectField
          label="Type"
          name="type"
          defaultValue={f.type ?? ""}
          options={[any, { value: "task", label: "Task" }, { value: "reminder", label: "Reminder" }]}
        />
        {creators.length > 1 && (
          <SelectField
            label="Creator"
            name="creator"
            defaultValue={f.creator ?? ""}
            options={[any, ...creators.map((c) => ({ value: c.id, label: c.name }))]}
          />
        )}
        <Field label="Tag" name="tag" defaultValue={f.tag} />
        <Field label="Sends from" name="from" type="date" defaultValue={f.from} />
        <Field label="Sends to" name="to" type="date" defaultValue={f.to} />
        <SelectField
          label="Sort"
          name="sort"
          defaultValue={f.sort}
          options={Object.entries(SORTS).map(([value, label]) => ({ value, label }))}
        />
        {f.failed && <input type="hidden" name="failed" value="1" />}
      </FilterBar>

      {f.failed && <p className={styles.note}>Showing reminders with a failed delivery in the last 30 days.</p>}

      <Table
        columns={["Title", "Status", "When", "Type", ...(f.show === "mine" ? [] : ["Creator"]), "Tags", "ID"]}
        empty={filtered ? "Nothing matches these filters." : "No reminders yet."}
        rows={rows.map((r) => {
          const delayed = isDelayed(r);
          return {
            key: r.id,
            href: `/reminders/${r.id}`,
            cells: [
              r.title,
              <Badge key="s" tone={statusTone(r)}>
                {delayed ? "Delayed" : statusLabel(r)}
              </Badge>,
              r.recurrence ? (
                <span key="w">
                  {describe(r.recurrence, r.anchorLocal)}
                  {r.status === "scheduled" && <Muted> · next {formatInZone(r.sendAt, r.timeZone)}</Muted>}
                </span>
              ) : (
                formatInZone(r.sendAt, r.timeZone)
              ),
              r.isTask ? "Task" : "Reminder",
              ...(f.show === "mine" ? [] : [<Muted key="c">{r.creatorName}</Muted>]),
              <span key="t" className={styles.tags}>
                {r.tags.map((t) => (
                  <Badge key={t} tone="accent">
                    {t}
                  </Badge>
                ))}
              </span>,
              <Muted key="id">{r.shortId}</Muted>,
            ],
          };
        })}
      />
      {total > 0 && <Pager page={f.page} total={total} pageSize={PAGE_SIZE} href={(page) => filterUrl({ ...f, page })} />}
    </Page>
  );
}
