import { deliveryVolume, duration, overdueTasks, type ReportFilters, taskCompletion } from "@/lib/reports";
import { formatInZone } from "@/lib/time";

// One table per report, shared by the page and the CSV export so they match.
export async function reportTable(companyId: string, tz: string, f: ReportFilters) {
  const by = { department: "Department", group: "Group", person: "Person" }[f.by];
  const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);
  if (f.report === "delivery") {
    const d = await deliveryVolume(companyId, tz, f);
    return {
      totals: d.totals,
      head: ["Time", "Email sent", "Email failed", "Slack sent", "Slack failed", "Pending"],
      rows: d.rows.map((r) => [r.bucket, r.email.sent, r.email.failed, r.slack.sent, r.slack.failed, r.email.pending + r.slack.pending]),
      pct,
    };
  }
  if (f.report === "tasks") {
    const t = await taskCompletion(companyId, tz, f);
    return {
      head: [by, "Assigned", "Done", "On time", "Completion", "Avg time to complete"],
      rows: t.map((r) => [r.name, r.assigned, r.done, r.on_time, pct(r.rate), duration(r.avg_minutes)]),
      rates: t.map((r) => r.rate),
      pct,
    };
  }
  const o = await overdueTasks(companyId, f);
  return {
    head: [by, "Overdue", "Oldest due"],
    rows: o.summary.map((r) => [r.name, r.overdue, formatInZone(r.oldest, tz)]),
    detail: o.detail.map((d) => ({ ...d, due: formatInZone(d.due_at, tz) })),
    pct,
  };
}
