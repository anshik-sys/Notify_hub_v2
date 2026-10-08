import { notFound } from "next/navigation";
import { can } from "@/lib/permissions";
import { parseReportFilters, toCsv } from "@/lib/reports";
import { requireMember } from "@/lib/session";
import { reportTable } from "../data";

// The current report as CSV (PRD 10), same filters and numbers as the page.
export async function GET(req: Request) {
  const { companyId, access, timeZone } = await requireMember();
  if (!can(access, "reports.view") || !can(access, "reports.export")) notFound();
  const f = parseReportFilters(Object.fromEntries(new URL(req.url).searchParams), timeZone);
  const t = await reportTable(companyId, timeZone, f);
  const csv =
    "detail" in t && t.detail
      ? toCsv(t.head, t.rows) + "\r\n" + toCsv(["Person", "Task", "Was due", "Days overdue"], t.detail.map((d) => [d.person, d.title, d.due, d.daysOverdue]))
      : toCsv(t.head, t.rows);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="report-${f.report}-${f.from}-to-${f.to}.csv"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
