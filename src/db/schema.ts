import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// Tenant isolation: every tenant table carries company_id and a policy that
// only matches rows of the company set by withTenant(). Unset => no rows.
// nullif: a pooled connection that once had it set reports '' rather than NULL.
const currentCompany = sql`nullif(current_setting('app.company_id', true), '')::uuid`;
const tenantPolicy = (column: string) =>
  pgPolicy("tenant_isolation", {
    for: "all",
    to: "public",
    using: sql`${sql.identifier(column)} = ${currentCompany}`,
    withCheck: sql`${sql.identifier(column)} = ${currentCompany}`,
  });

export const companies = pgTable(
  "companies",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    domain: text().notNull().unique(),
    timeZone: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  () => [tenantPolicy("id")],
).enableRLS();

export const departments = pgTable(
  "departments",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    name: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.companyId, t.name), tenantPolicy("company_id")],
).enableRLS();
