import { sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/db";
import { csvCell } from "./audit";
import { toLocalInput, zonedToUtc } from "./time";

// Reports (PRD 10). Aggregates in SQL, under RLS (company only), bucketed in
// the viewer's time zone. Definitions:
// - a delivery's time is sent_at, or its last update if it never sent;
// - success rate = sent / (sent + failed); pending isn't counted either way;
// - tasks are counted by their occurrence's due date; "on time" = done_at <= due_at;
//   time to complete = done_at - the occurrence's send time;
// - someone in two departments (or groups) counts in each;
// - overdue is the current state (open and past due), whatever the date range.

export const REPORTS = ["delivery", "tasks", "overdue"] as const;
const BUCKETS = ["hour", "day", "month"] as const;
const BY = ["department", "group", "person"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

export type ReportFilters = {
  report: (typeof REPORTS)[number];
  from: string;
  to: string;
  bucket: (typeof BUCKETS)[number];
  by: (typeof BY)[number];
};
type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
const pick = <T extends string>(v: string, allowed: readonly T[], d: T) => (allowed.includes(v as T) ? (v as T) : d);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00Z`) + n * DAY).toISOString().slice(0, 10);

// Defaults: the last 30 days, by day, by department. Junk is dropped.
export function parseReportFilters(p: Params, timeZone: string, now = new Date()): ReportFilters {
  const today = toLocalInput(now, timeZone).slice(0, 10);
  let to = DATE.test(one(p.to)) ? one(p.to) : today;
  let from = DATE.test(one(p.from)) ? one(p.from) : addDays(to, -29);
  if (from > to) [from, to] = [to, from];
  const days = (Date.parse(to) - Date.parse(from)) / DAY + 1;
  let bucket = pick(one(p.bucket), BUCKETS, "day");
  if (bucket === "hour" && days > 7) bucket = "day"; // hourly only for a week or less
  return { report: pick(one(p.report), REPORTS, "delivery"), from, to, bucket, by: pick(one(p.by), BY, "department") };
}

const range = (f: ReportFilters, tz: string) => ({
  start: zonedToUtc(`${f.from}T00:00`, tz)!,
  end: zonedToUtc(`${addDays(f.to, 1)}T00:00`, tz)!,
});

type Rows<T> = { rows: T[] };

export async function deliveryVolume(companyId: string, tz: string, f: ReportFilters) {
  const { start, end } = range(f, tz);
  const label = { hour: "YYYY-MM-DD HH24:00", day: "YYYY-MM-DD", month: "YYYY-MM" }[f.bucket];
  const at = sql`coalesce(d.sent_at, d.updated_at)`;
  const res = (await withTenant(companyId, (tx) =>
    tx.execute(sql`
      select to_char(date_trunc(${f.bucket}, ${at} at time zone ${tz}), ${label}) as bucket, d.channel,
        count(*) filter (where d.status = 'sent')::int as sent,
        count(*) filter (where d.status = 'failed')::int as failed,
        count(*) filter (where d.status in ('queued', 'sending'))::int as pending
      from deliveries d
      where ${at} >= ${start} and ${at} < ${end}
      group by 1, 2 order by 1, 2`),
  )) as unknown as Rows<{ bucket: string; channel: "email" | "slack"; sent: number; failed: number; pending: number }>;
  const buckets = new Map<string, Record<"email" | "slack", { sent: number; failed: number; pending: number }>>();
  const totals = { email: { sent: 0, failed: 0, pending: 0 }, slack: { sent: 0, failed: 0, pending: 0 } };
  for (const r of res.rows) {
    const b = buckets.get(r.bucket) ?? { email: { sent: 0, failed: 0, pending: 0 }, slack: { sent: 0, failed: 0, pending: 0 } };
    b[r.channel] = { sent: r.sent, failed: r.failed, pending: r.pending };
    buckets.set(r.bucket, b);
    for (const k of ["sent", "failed", "pending"] as const) totals[r.channel][k] += r[k];
  }
  const rate = (c: { sent: number; failed: number }) => (c.sent + c.failed ? c.sent / (c.sent + c.failed) : null);
  return {
    rows: [...buckets.entries()].map(([bucket, c]) => ({ bucket, ...c })),
    totals: { email: { ...totals.email, rate: rate(totals.email) }, slack: { ...totals.slack, rate: rate(totals.slack) } },
  };
}

// The grouping join and name for department / group / person.
function groupBy(by: ReportFilters["by"]): { join: SQL; name: SQL } {
  if (by === "person") return { join: sql`join "user" g on g.id = ta.user_id`, name: sql`g.name` };
  if (by === "group")
    return {
      join: sql`left join group_members gm on gm.user_id = ta.user_id left join groups g on g.id = gm.group_id`,
      name: sql`coalesce(g.name, 'No group')`,
    };
  return {
    join: sql`left join department_members dm on dm.user_id = ta.user_id left join departments g on g.id = dm.department_id`,
    name: sql`coalesce(g.name, 'No department')`,
  };
}

export async function taskCompletion(companyId: string, tz: string, f: ReportFilters) {
  const { start, end } = range(f, tz);
  const g = groupBy(f.by);
  const res = (await withTenant(companyId, (tx) =>
    tx.execute(sql`
      select ${g.name} as name, count(*)::int as assigned, count(ta.done_at)::int as done,
        count(*) filter (where ta.done_at <= o.due_at)::int as on_time,
        round(avg(extract(epoch from ta.done_at - o.occurs_at) / 60) filter (where ta.done_at is not null))::int as avg_minutes
      from task_assignments ta
      join reminder_occurrences o on o.id = ta.occurrence_id
      join reminders r on r.id = ta.reminder_id
      ${g.join}
      where o.due_at >= ${start} and o.due_at < ${end} and r.status <> 'cancelled'
      group by 1 order by 1`),
  )) as unknown as Rows<{ name: string; assigned: number; done: number; on_time: number; avg_minutes: number | null }>;
  return res.rows.map((r) => ({ ...r, rate: r.assigned ? r.done / r.assigned : 0 }));
}

export async function overdueTasks(companyId: string, f: ReportFilters, now = new Date()) {
  const g = groupBy(f.by);
  const open = sql`ta.done_at is null and o.due_at < ${now} and r.status <> 'cancelled'`;
  const [summary, detail] = await withTenant(companyId, async (tx) => [
    (await tx.execute(sql`
      select ${g.name} as name, count(*)::int as overdue, min(o.due_at) as oldest
      from task_assignments ta
      join reminder_occurrences o on o.id = ta.occurrence_id
      join reminders r on r.id = ta.reminder_id
      ${g.join}
      where ${open}
      group by 1 order by 2 desc, 1`)) as unknown as Rows<{ name: string; overdue: number; oldest: Date }>,
    (await tx.execute(sql`
      select u.name as person, r.id as reminder_id, r.title, o.due_at
      from task_assignments ta
      join reminder_occurrences o on o.id = ta.occurrence_id
      join reminders r on r.id = ta.reminder_id
      join "user" u on u.id = ta.user_id
      where ${open}
      order by o.due_at limit 200`)) as unknown as Rows<{ person: string; reminder_id: string; title: string; due_at: Date }>,
  ]);
  const days = (d: Date) => Math.floor((now.getTime() - new Date(d).getTime()) / DAY);
  return {
    summary: summary.rows.map((r) => ({ ...r, oldest: new Date(r.oldest) })),
    detail: detail.rows.map((r) => ({ ...r, due_at: new Date(r.due_at), daysOverdue: days(r.due_at) })),
  };
}

// "2 h 5 m", "3 d 4 h"
export function duration(minutes: number | null) {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes} m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
  return `${Math.floor(minutes / 1440)} d ${Math.floor((minutes % 1440) / 60)} h`;
}

export const toCsv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
