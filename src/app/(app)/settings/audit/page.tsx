import Link from "next/link";
import { notFound } from "next/navigation";
import { FilterBar, Pager } from "@/components/filters";
import { Field, LinkButton, Page, SelectField } from "@/components/form";
import { Badge, Muted, Table } from "@/components/table";
import { AUDIT_PAGE, auditActors, listAudit, OBJECT_TYPES, parseAuditFilters, type AuditFilters } from "@/lib/audit";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";
import styles from "./page.module.css";

const any = { value: "", label: "Any" };
const LINKS: Record<string, string> = {
  reminders: "/reminders/",
  reminder_targets: "/reminders/",
  reminder_shares: "/reminders/",
  attachments: "/reminders/",
  comments: "",
  task_assignments: "/reminders/",
  departments: "/departments/",
  department_members: "/departments/",
  groups: "/groups/",
  group_members: "/groups/",
  user: "/users/",
  user_roles: "/users/",
};
const query = (f: Partial<AuditFilters>) =>
  new URLSearchParams(Object.entries(f).filter(([k, v]) => v !== undefined && v !== "" && !(k === "page" && v === 1)).map(([k, v]) => [k, String(v)])).toString();
const show = (v: unknown) => {
  const s = v === null || v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

// PRD 9.1: who changed what, when. Filters are in the URL; the export uses the same ones.
export default async function AuditLog(props: PageProps<"/settings/audit">) {
  const { companyId, access, timeZone } = await requireMember();
  if (!can(access, "audit.view")) notFound();
  const f = parseAuditFilters(await props.searchParams);
  const [{ rows, total }, actors] = await Promise.all([listAudit(companyId, timeZone, f), auditActors(companyId)]);
  const qs = query({ ...f, page: 1 });

  return (
    <Page title="Audit log" actions={<LinkButton href={`/settings/audit/export${qs ? `?${qs}` : ""}`} variant="secondary">Export CSV</LinkButton>}>
      <FilterBar action="/settings/audit" clearHref={qs ? "/settings/audit" : undefined}>
        <Field label="Search" name="q" type="search" placeholder="Object name or title" defaultValue={f.q} />
        <SelectField label="Who" name="actor" defaultValue={f.actor ?? ""} options={[any, ...actors.map((a) => ({ value: a.id!, label: a.name ?? a.id! }))]} />
        <SelectField label="What" name="type" defaultValue={f.type ?? ""} options={[any, ...Object.entries(OBJECT_TYPES).map(([value, label]) => ({ value, label }))]} />
        <SelectField
          label="Action"
          name="action"
          defaultValue={f.action ?? ""}
          options={[any, { value: "create", label: "Created" }, { value: "update", label: "Changed" }, { value: "delete", label: "Deleted" }]}
        />
        <Field label="From" name="from" type="date" defaultValue={f.from} />
        <Field label="To" name="to" type="date" defaultValue={f.to} />
      </FilterBar>
      <Table
        columns={["When", "Who", "Action", "What", "Details"]}
        empty={qs ? "Nothing matches these filters." : "Nothing recorded yet."}
        rows={rows.map((r) => {
          const base = LINKS[r.objectType];
          const what = (
            <span>
              <Muted>{OBJECT_TYPES[r.objectType] ?? r.objectType}</Muted> {r.objectLabel}
            </span>
          );
          const entries = Object.entries(r.changes);
          return {
            key: String(r.id),
            cells: [
              <Muted key="t">{formatInZone(r.at, timeZone)}</Muted>,
              r.actorName ?? "Removed person",
              <Badge key="a" tone={r.action === "delete" ? "danger" : "neutral"}>
                {r.action === "create" ? "Created" : r.action === "update" ? "Changed" : "Deleted"}
              </Badge>,
              base && r.objectId && r.action !== "delete" ? (
                <Link key="w" href={`${base}${r.objectId}`}>
                  {what}
                </Link>
              ) : (
                <span key="w">{what}</span>
              ),
              <details key="d" className={styles.details}>
                <summary>{entries.length} field{entries.length === 1 ? "" : "s"}</summary>
                <ul>
                  {entries.map(([k, v]) => (
                    <li key={k}>
                      <code>{k}</code>:{" "}
                      {r.action === "update" && Array.isArray(v) ? `${show(v[0])} → ${show(v[1])}` : show(v)}
                    </li>
                  ))}
                </ul>
              </details>,
            ],
          };
        })}
      />
      {total > 0 && <Pager page={f.page} total={total} pageSize={AUDIT_PAGE} href={(page) => `/settings/audit?${query({ ...f, page })}`} />}
    </Page>
  );
}
