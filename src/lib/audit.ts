import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/db";
import { auditLog } from "@/db/schema";
import { zonedToUtc } from "./time";

// Reading the audit log (PRD 9.1). Rows are written by the audit_row()
// trigger (migration 0024), never by app code.

export const OBJECT_TYPES: Record<string, string> = {
  reminders: "Reminder",
  reminder_targets: "Reminder recipient",
  reminder_shares: "Reminder sharing",
  attachments: "Attachment",
  comments: "Comment",
  task_assignments: "Task",
  departments: "Department",
  department_members: "Department member",
  groups: "Group",
  group_members: "Group member",
  roles: "Role",
  user_roles: "Role assignment",
  user: "Person",
  invitations: "Invitation",
  companies: "Company settings",
  slack_installations: "Slack connection",
};
const ACTIONS = ["create", "update", "delete"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const AUDIT_PAGE = 50;

export type AuditFilters = { q: string; actor?: string; type?: string; action?: (typeof ACTIONS)[number]; from?: string; to?: string; page: number };
type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";

export function parseAuditFilters(p: Params): AuditFilters {
  const page = Number(one(p.page));
  const action = one(p.action);
  return {
    q: one(p.q).slice(0, 100),
    actor: one(p.actor) && one(p.actor).length <= 64 ? one(p.actor) : undefined,
    type: one(p.type) in OBJECT_TYPES ? one(p.type) : undefined,
    action: (ACTIONS as readonly string[]).includes(action) ? (action as AuditFilters["action"]) : undefined,
    from: DATE.test(one(p.from)) ? one(p.from) : undefined,
    to: DATE.test(one(p.to)) ? one(p.to) : undefined,
    page: Number.isInteger(page) && page > 0 && page < 100_000 ? page : 1,
  };
}

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function where(f: AuditFilters, timeZone: string) {
  const w: (SQL | undefined)[] = [];
  if (f.q) w.push(sql`${auditLog.objectLabel} ilike ${`%${f.q.replace(/[\\%_]/g, "\\$&")}%`}`);
  if (f.actor) w.push(eq(auditLog.actorId, f.actor));
  if (f.type) w.push(eq(auditLog.objectType, f.type));
  if (f.action) w.push(eq(auditLog.action, f.action));
  if (f.from) w.push(gte(auditLog.at, zonedToUtc(`${f.from}T00:00`, timeZone)!));
  if (f.to) w.push(lt(auditLog.at, zonedToUtc(`${nextDay(f.to)}T00:00`, timeZone)!));
  return and(...w);
}

export async function listAudit(companyId: string, timeZone: string, f: AuditFilters, limit = AUDIT_PAGE) {
  const rows = await withTenant(companyId, (tx) =>
    tx
      .select({ row: auditLog, total: sql<number>`count(*) over ()::int` })
      .from(auditLog)
      .where(where(f, timeZone))
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(limit)
      .offset((f.page - 1) * limit),
  );
  return { rows: rows.map((r) => r.row), total: rows[0]?.total ?? 0 };
}

// People who appear as actors (the Actor filter).
export function auditActors(companyId: string) {
  return withTenant(companyId, (tx) =>
    tx
      .selectDistinct({ id: auditLog.actorId, name: auditLog.actorName })
      .from(auditLog)
      .where(sql`${auditLog.actorId} is not null`)
      .orderBy(auditLog.actorName),
  );
}

// RFC 4180 quoting, and a leading = + - @ tab or CR is defused with ' so a
// spreadsheet never runs it as a formula (same rule as uploads).
export const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function auditCsv(rows: (typeof auditLog.$inferSelect)[]) {
  const head = ["time_utc", "actor", "actor_id", "action", "object_type", "object_id", "object", "changes"];
  const lines = rows.map((r) =>
    [r.at.toISOString(), r.actorName, r.actorId, r.action, OBJECT_TYPES[r.objectType] ?? r.objectType, r.objectId, r.objectLabel, r.changes]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}
