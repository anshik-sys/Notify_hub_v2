import { randomUUID } from "node:crypto";
import { Pool } from "pg";

// Seeds through the table owner (bypasses RLS). Every test file makes its own
// company with a random domain and calls cleanup() in after().
export function seeder() {
  const owner = new Pool({ connectionString: process.env.OWNER_DATABASE_URL });
  const companyId = randomUUID();
  const domain = `${companyId}.test`;
  const userIds: string[] = [];

  return {
    owner,
    companyId,
    domain,
    async company() {
      await owner.query("insert into companies (id, name, domain, time_zone) values ($1, 'Test Co', $2, 'UTC')", [companyId, domain]);
    },
    async user(opts: { company?: boolean; roles?: string[]; email?: string } = {}) {
      const id = randomUUID();
      userIds.push(id);
      await owner.query(
        `insert into "user" (id, name, email, email_verified, company_id, updated_at) values ($1, $1, $2, true, $3, now())`,
        [id, opts.email ?? `${id}@${domain}`, opts.company === false ? null : companyId],
      );
      for (const roleId of opts.roles ?? [])
        await owner.query("insert into user_roles (company_id, user_id, role_id) values ($1, $2, $3)", [companyId, id, roleId]);
      return id;
    },
    async cleanup() {
      for (const t of ["notifications", "notification_mutes", "comments", "groups", "slack_installations", "reminders", "invitations", "department_members", "user_roles", "roles", "departments"])
        await owner.query(`delete from ${t} where company_id = $1`, [companyId]);
      await owner.query(`delete from session where user_id = any($1)`, [userIds]);
      await owner.query(`delete from "user" where id = any($1)`, [userIds]);
      await owner.query("delete from companies where id = $1", [companyId]);
      await owner.end();
    },
  };
}
