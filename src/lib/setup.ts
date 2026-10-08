import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { companies } from "@/db/schema";
import { createDepartment } from "./departments";

// The guided setup after onboarding (PRD 3.1). Every step's "done" is read
// from the real data, so doing it anywhere in the app counts and nothing can
// drift; only "dismissed" is stored.

export async function setupStatus(companyId: string, adminId: string) {
  const [r] = (await withTenant(companyId, (tx) =>
    tx.execute(sql`select
      (select count(*)::int from departments) as departments,
      (select count(*)::int from departments d where not exists (
         select 1 from department_members m where m.department_id = d.id and m.is_manager)) as without_manager,
      (select count(*)::int from "user" where id <> ${adminId} and erased_at is null) as others,
      (select count(*)::int from invitations where accepted_at is null and expires_at > now()) as invites,
      exists (select 1 from slack_installations) as slack,
      exists (select 1 from reminders) as reminder,
      (select setup_dismissed_at is not null from companies where id = ${companyId}) as dismissed`),
  )).rows as {
    departments: number;
    without_manager: number;
    others: number;
    invites: number;
    slack: boolean;
    reminder: boolean;
    dismissed: boolean;
  }[];
  const steps = {
    departments: r.departments > 0,
    people: r.others + r.invites > 0,
    managers: r.departments > 0 && r.without_manager === 0,
    slack: r.slack,
    reminder: r.reminder,
  };
  const required = [steps.departments, steps.people, steps.managers];
  return { steps, withoutManager: r.without_manager, done: required.filter(Boolean).length, complete: required.every(Boolean), dismissed: r.dismissed };
}

export async function dismissSetup(companyId: string) {
  await withTenant(companyId, (tx) => tx.update(companies).set({ setupDismissedAt: new Date() }).where(eq(companies.id, companyId)));
}

// One name per line: trimmed, blanks and repeats skipped. Names that already
// exist are reported, not errors.
export function parseLines(text: string, max = 50) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const v = line.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out.slice(0, max);
}

export async function createDepartments(companyId: string, text: string) {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const name of parseLines(text)) {
    const error = await createDepartment(companyId, name);
    if (!error) created.push(name);
    else skipped.push(`${name} (${error.replace(/\.$/, "").toLowerCase()})`);
  }
  return { created, skipped };
}
