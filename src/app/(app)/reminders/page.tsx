import { notFound } from "next/navigation";
import { FilterBar, Pager } from "@/components/filters";
import { Field, firstParam, Page, SelectField } from "@/components/form";
import { NewMenu } from "@/components/new-menu";
import { Badge, Muted, Table } from "@/components/table";
import { REMINDER_STATUSES } from "@/db/schema";
import { can } from "@/lib/permissions";
import { describe } from "@/lib/recurrence";
import { isDelayed, STATUS_LABELS, statusLabel } from "@/lib/reminders";
import { isWaiting } from "@/lib/tasks";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";
import { filterUrl, PAGE_SIZE, parseFilters, searchReminders, SORTS, visibleCreators } from "@/lib/views";
import styles from "./page.module.css";

const any = { value: "", label: "Any" };

export default async function Reminders(props: PageProps<"/reminders">) {
  const { user, companyId, access, timeZone } = await requireMember();
  if (!can(access, "reminders.create") && !can(access, "reminders.view_all")) notFound();
  const viewer = { id: user.id, access };
  const params = await props.searchParams;
  const f = parseFilters(params);
  const [{ rows, total }, creators] = await Promise.all([
    searchReminders(companyId, viewer, timeZone, f),
    visibleCreators(companyId, viewer),
  ]);
  const filtered = filterUrl({ ...f, page: 1 }) !== "/reminders";

  return (
    <Page
      title="Reminders"
      notice={firstParam(params.notice)}
      actions={can(access, "reminders.create") && <NewMenu id="new-menu-page" />}
    >
      <FilterBar
        action="/reminders"
        clearHref={filtered ? "/reminders" : undefined}
        moreOpen={Boolean(f.channel || f.repeat || f.creator || f.tag || f.from || f.to || f.sort !== "send_desc")}
        more={
          <>
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
          </>
        }
      >
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
          label="Type"
          name="type"
          defaultValue={f.type ?? ""}
          options={[any, { value: "task", label: "Task" }, { value: "reminder", label: "Reminder" }, { value: "event", label: "Event" }]}
        />
        {f.failed && <input type="hidden" name="failed" value="1" />}
      </FilterBar>

      {f.failed && <p className={styles.note}>Showing reminders with a failed delivery in the last 30 days.</p>}

      <Table
        columns={["Title", "Status", "When", ...(f.show === "mine" ? [] : ["Creator"]), "Tags"]}
        empty={filtered ? "Nothing matches these filters." : "No reminders yet."}
        rows={rows.map((r) => {
          const delayed = isDelayed(r);
          return {
            key: r.id,
            href: `/reminders/${r.id}`,
            cells: [
              // ID: on the reminder itself, and searchable here.
              r.isTask ? (
                <span key="t" className={styles.title}>
                  {r.title} <Badge>Task</Badge>
                </span>
              ) : (
                r.title
              ),
              <Badge key="s" tone={delayed || r.status === "rejected" ? "danger" : "neutral"}>
                {delayed ? "Delayed" : statusLabel(r)}
              </Badge>,
              r.recurrence ? (
                <span key="w">
                  {describe(r.recurrence, r.anchorLocal)}
                  {r.status === "scheduled" && <Muted> · next {formatInZone(r.sendAt, r.timeZone)}</Muted>}
                </span>
              ) : isWaiting(r) ? (
                <Muted key="w">When a task is done</Muted>
              ) : (
                formatInZone(r.sendAt, r.timeZone)
              ),
              ...(f.show === "mine" ? [] : [<Muted key="c">{r.creatorName}</Muted>]),
              <span key="t" className={styles.tags}>
                {r.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </span>,
            ],
          };
        })}
      />
      {total > 0 && <Pager page={f.page} total={total} pageSize={PAGE_SIZE} href={(page) => filterUrl({ ...f, page })} />}
    </Page>
  );
}
