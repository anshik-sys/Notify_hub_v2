import { notFound } from "next/navigation";
import { auditCsv, listAudit, parseAuditFilters } from "@/lib/audit";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";

// The audit log as CSV, with the page's filters (PRD 9.1 "exportable").
// ponytail: one query capped at 50,000 rows; stream it if anyone needs more.
const MAX_ROWS = 50_000;

export async function GET(req: Request) {
  const { companyId, access, timeZone } = await requireMember();
  if (!can(access, "audit.view")) notFound();
  const f = parseAuditFilters(Object.fromEntries(new URL(req.url).searchParams));
  const { rows } = await listAudit(companyId, timeZone, { ...f, page: 1 }, MAX_ROWS);
  return new Response(auditCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
