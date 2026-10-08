import { Tabs } from "@/components/tabs";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FilterBar } from "@/components/filters";
import { Field, LinkButton, Page, Section, SelectField } from "@/components/form";
import { StatCards } from "@/components/stats";
import { Bar, Muted, Table } from "@/components/table";
import { can } from "@/lib/permissions";
import { parseReportFilters, type ReportFilters } from "@/lib/reports";
import { requireMember } from "@/lib/session";
import { reportTable } from "./data";
import styles from "./page.module.css";

const TABS: [ReportFilters["report"], string][] = [
  ["delivery", "Deliveries"],
  ["tasks", "Task completion"],
  ["overdue", "Overdue"],
];
const qs = (f: Partial<ReportFilters>) => new URLSearchParams(Object.entries(f).map(([k, v]) => [k, String(v)])).toString();

// PRD 10. Everything is filtered in the URL; the CSV export uses the same filters.
export default async function Reports(props: PageProps<"/reports">) {
  const { companyId, access, timeZone } = await requireMember();
  if (!can(access, "reports.view")) notFound();
  const f = parseReportFilters(await props.searchParams, timeZone);
  const t = await reportTable(companyId, timeZone, f);
  const max = Math.max(1, ...t.rows.map((r) => (f.report === "delivery" ? Number(r[1]) + Number(r[2]) + Number(r[3]) + Number(r[4]) : Number(r[1]))));

  return (
    <Page
      title="Reports"
      actions={
        can(access, "reports.export") && (
          <LinkButton href={`/reports/export?${qs(f)}`} variant="secondary">
            Export CSV
          </LinkButton>
        )
      }
    >
      <Tabs label="Report" tabs={TABS.map(([key, label]) => ({ href: `/reports?${qs({ ...f, report: key })}`, label, current: f.report === key }))} />
      <FilterBar action="/reports">
        <input type="hidden" name="report" value={f.report} />
        {f.report !== "overdue" && <Field label="From" name="from" type="date" defaultValue={f.from} />}
        {f.report !== "overdue" && <Field label="To" name="to" type="date" defaultValue={f.to} />}
        {f.report === "delivery" ? (
          <SelectField
            label="By"
            name="bucket"
            defaultValue={f.bucket}
            options={[
              { value: "hour", label: "Hour (up to 7 days)" },
              { value: "day", label: "Day" },
              { value: "month", label: "Month" },
            ]}
          />
        ) : (
          <SelectField
            label="Group by"
            name="by"
            defaultValue={f.by}
            options={[
              { value: "department", label: "Department" },
              { value: "group", label: "Group (team)" },
              { value: "person", label: "Person" },
            ]}
          />
        )}
      </FilterBar>

      {"totals" in t && t.totals && (
        <StatCards
          items={(["email", "slack"] as const).flatMap((c) => [
            { label: `${c === "email" ? "Email" : "Slack"} sent`, value: t.totals![c].sent, href: "#volume" },
            { label: `${c === "email" ? "Email" : "Slack"} failed`, value: t.totals![c].failed, href: "#volume", tone: "danger" as const },
          ])}
        />
      )}
      {"totals" in t && t.totals && (
        <p className={styles.rates}>
          Success rate: email {t.pct(t.totals.email.rate)}, Slack {t.pct(t.totals.slack.rate)}
          <Muted> (sent ÷ sent + failed, {f.from} to {f.to}, {timeZone})</Muted>
        </p>
      )}
      {f.report === "overdue" && <p className={styles.rates}>Open tasks past their due time, right now.</p>}

      <div id="volume">
        <Table
          columns={[...t.head, ""]}
          empty={f.report === "overdue" ? "Nothing overdue." : "Nothing in this period."}
          rows={t.rows.map((r, i) => ({
            key: String(r[0]) + i,
            cells: [
              ...r.map((c) => (typeof c === "number" ? c : String(c))),
              f.report === "tasks" && "rates" in t ? (
                <Bar key="b" value={t.rates![i]} max={1} />
              ) : (
                <Bar key="b" value={f.report === "delivery" ? Number(r[1]) + Number(r[2]) + Number(r[3]) + Number(r[4]) : Number(r[1])} max={max} />
              ),
            ],
          }))}
        />
      </div>

      {"detail" in t && t.detail && t.detail.length > 0 && (
        <Section title="Overdue tasks">
          <Table
            columns={["Person", "Task", "Was due", "Days overdue"]}
            rows={t.detail.map((d, i) => ({
              key: `${d.reminder_id}-${i}`,
              cells: [
                d.person,
                <Link key="t" href={`/reminders/${d.reminder_id}`}>
                  {d.title}
                </Link>,
                d.due,
                d.daysOverdue,
              ],
            }))}
          />
        </Section>
      )}
    </Page>
  );
}
