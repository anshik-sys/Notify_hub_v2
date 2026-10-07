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
| `src/db/index.ts` | `db` client (role `notifyhub_app`) and `withTenant()`. |
| `src/lib/auth.ts` | Better Auth config and `authDb` (role `notifyhub_auth`). |
| `src/lib/permissions.ts` | Permission catalogue, system role ids, `can()`, `loadAccess()`. |
| `src/lib/session.ts` | `requireMember()`: session + company + permissions, or redirect. |
| `src/app/settings/roles/` | Custom role management (`roles.manage`). |
| `src/lib/mail.ts` | `sendMail()`: one recipient per message, over SMTP (Mailpit in dev, SES in prod). |
| `src/lib/onboarding.ts` | Creates a company and attaches the signed-in user, in one transaction. |
| `src/app/form.tsx` + `form.module.css` | Shared form components (FormPage, Field, Button, …). |
| `src/app/globals.css` | Design tokens (CSS variables, light and dark) and element defaults. |
| `src/app/sign-in`, `sign-up`, `onboarding` | Server-rendered forms posting to server actions. No client-side auth code. |
| `src/app/api/auth/[...all]` | Better Auth's HTTP endpoints (sessions, OAuth callbacks). |
| `drizzle/` | SQL migrations. `0001` is hand-written; `0003` is generated plus hand-added role creation and grants. |

## Local setup

```sh
pnpm install
createdb notifyhub
cp .env.example .env
pnpm db:migrate
psql notifyhub -c "ALTER ROLE notifyhub_app PASSWORD 'dev'"
psql notifyhub -c "ALTER ROLE notifyhub_auth PASSWORD 'dev'"
# Mailpit on localhost:1025 (SMTP) / :8025 (UI) catches all mail
pnpm test        # tenant isolation and onboarding tests
pnpm dev         # web
pnpm worker      # scheduler
```

## Constraints you cannot see from the code

- **Three database roles, on purpose.**
  - `DATABASE_URL` → `notifyhub_app`: all app code, through RLS. It has no
    grant on `session`, `account` or `verification` (tokens, password hashes).
  - `AUTH_DATABASE_URL` → `notifyhub_auth`: Better Auth only. It has an
    `auth_unscoped` policy on `user` and `companies`, because sign-in looks a
    user up by email before any company is known, and onboarding creates the
    company. It has no grant on tenant data tables (`departments`, etc.).
  - `OWNER_DATABASE_URL` → table owner: migrations and the worker. Bypasses RLS.

  Pointing `DATABASE_URL` at the owner, a superuser or `notifyhub_auth` silently
  disables tenant isolation, and every query still "works". None of these roles
  use `BYPASSRLS`, which managed Postgres often refuses to grant.
- **Permissions are checked on the server, in every page and server action:**
  `requireMember()` then `can(access, "<permission>", departmentId?)`. Hiding a
  link is cosmetic. Server actions are public POST endpoints that anyone can
  call directly (tested: a Member calling the create-role action gets 404).
- **The permission catalogue is code** (`PERMISSION_GROUPS`), not a table.
  Roles store permission keys as `text[]`, and unknown keys are ignored on load.
- **Company Admin means "every permission", decided in `loadAccess()`.** Its row
  stores `'{}'`. Don't fill it in: a new catalogue key would then need a data
  migration, or admins would silently lack it.
- **System roles (`company_id IS NULL`) are readable by every company and
  writable by none.** The tenant policy's WITH CHECK can't match NULL. Their ids
  are fixed in code and in migration 0004.
- **Manager permissions are fixed in code** (`MANAGER_PERMISSIONS`) and apply
  only when `can()` is given a department the user manages
  (`department_members.is_manager`).
- **`authDb` must not be imported outside `src/lib`.** It sees every company's users.
- **`user.company_id` is set only server-side.** It's a Better Auth
  `additionalField` with `input: false`. Better Auth rejects it from
  `/update-user` with `FIELD_NOT_ALLOWED`. Do not flip `input` to true.
- **A company's domain is claimed by whoever onboards first with a verified
  email at that domain.** Email verification is what makes that claim mean
  anything. It's enforced twice: Better Auth refuses unverified sign-ins, and
  `createCompany` checks `emailVerified` again. Keep both.
- **`sendVerificationEmail` doesn't await the send, on purpose.** Sign-up gives
  the same response for new and existing emails. Awaiting SMTP only for new ones
  would reveal by timing which emails are registered.
- **Verification links carry a signed token (JWT, 1 hour), not a stored one.** It
  can't be revoked before expiry, but once the email is verified, reusing the
  link only redirects and doesn't sign anyone in.
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
