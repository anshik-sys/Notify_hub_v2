# NotifyHub

Multi-tenant reminder and notification SaaS. Product spec: `PRD.md`. How we
work: `WORKING_AGREEMENT.md`. Log: `PROGRESS.md`.

## Layout

One package, two processes, one Postgres:

| Path | What |
|---|---|
| `src/app/` | Next.js 16 web app and API (App Router). |
| `src/worker/index.ts` | Long-running worker: pg-boss queue, per-minute scheduler tick. Run with `pnpm worker`. |
| `src/db/schema.ts` | Drizzle schema, including RLS policies. |
| `src/db/index.ts` | `db` client and `withTenant()`. |
| `drizzle/` | SQL migrations. Generated, except `0001_app_role.sql` (hand-written). |

## Local setup

```sh
pnpm install
createdb notifyhub
cp .env.example .env
pnpm db:migrate
psql notifyhub -c "ALTER ROLE notifyhub_app PASSWORD 'dev'"
pnpm test        # tenant isolation test
pnpm dev         # web
pnpm worker      # scheduler
```

## Constraints you cannot see from the code

- **Two database roles, on purpose.** `DATABASE_URL` (web) connects as
  `notifyhub_app`, which is subject to row-level security. `OWNER_DATABASE_URL`
  (migrations, worker) is the table owner and bypasses RLS. Pointing
  `DATABASE_URL` at the owner or a superuser silently disables tenant isolation;
  every query still "works".
- **Tenant queries must go through `withTenant(companyId, fn)`.** It sets
  `app.company_id` with `set_config(..., true)`, so the setting is
  transaction-local. Changing it to session-level (`false`) leaks one tenant's id
  into the next request on the same pooled connection.
- **The policies use `nullif(current_setting(...), '')`.** After a connection has
  once had the setting, Postgres reports `''` instead of NULL, and `''::uuid`
  throws. Without `nullif`, unscoped queries error instead of returning no rows.
- **RLS is the second layer, not the only one.** Server code still checks
  permissions explicitly (PRD 2.1). Do not drop an app-level check because RLS
  "covers it".
- **The worker cannot run on serverless.** It holds a persistent connection and
  runs a cron every minute.
- `package.json` has `"type": "module"`, which the worker's top-level `await` needs.
