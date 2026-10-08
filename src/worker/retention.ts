import { sql } from "drizzle-orm";
import { ownerDb } from "./db";

// Data retention (PRD 9.1, 11.5). Daily, per company that set a period:
// finished reminders (sent, cancelled, rejected) untouched that long go, with
// everything that cascades from them (occurrences, deliveries, targets,
// shares, comments, attachments and their bytes, tasks, notifications); then
// older notifications and audit entries. Upcoming and active reminders are
// never touched. Each purge leaves one audit row saying what it removed.
// Batches of 1,000 keep a large first purge from holding long locks.

const BATCH = 1000;

async function inBatches(statement: () => ReturnType<typeof ownerDb.execute>) {
  let total = 0;
  for (;;) {
    const res = (await statement()) as unknown as { rowCount: number };
    total += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < BATCH) return total;
  }
}

export async function purgeCompany(companyId: string, days: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const reminders = await inBatches(() =>
    ownerDb.execute(sql`delete from reminders where id in (
      select id from reminders where company_id = ${companyId} and status in ('sent', 'cancelled', 'rejected') and updated_at < ${cutoff}
      limit ${BATCH})`),
  );
  const notifications = await inBatches(() =>
    ownerDb.execute(sql`delete from notifications where id in (
      select id from notifications where company_id = ${companyId} and created_at < ${cutoff} limit ${BATCH})`),
  );
  const audit = await inBatches(() =>
    ownerDb.execute(sql`delete from audit_log where id in (
      select id from audit_log where company_id = ${companyId} and at < ${cutoff} limit ${BATCH})`),
  );
  if (reminders + notifications + audit > 0)
    await ownerDb.execute(sql`insert into audit_log (company_id, actor_name, action, object_type, object_label, changes)
      values (${companyId}, 'System', 'delete', 'retention', ${`Older than ${days} days`},
        ${JSON.stringify({ reminders, notifications, audit_entries: audit })}::jsonb)`);
  return { reminders, notifications, audit };
}

export async function runRetention(now = new Date()) {
  const res = (await ownerDb.execute(sql`select id, retention_days from companies where retention_days is not null`)) as unknown as {
    rows: { id: string; retention_days: number }[];
  };
  for (const c of res.rows)
    await purgeCompany(c.id, c.retention_days, now)
      .then((r) => console.log("retention", c.id, r))
      .catch((e) => console.error("retention failed", c.id, e));
}
