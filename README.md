# NotifyHub

Multi-tenant reminder and notification SaaS. Product spec: `PRD.md`. How we
work: `WORKING_AGREEMENT.md`. Log: `PROGRESS.md`.

## Layout

One package, two processes, one Postgres:

| Path | What |
|---|---|
| `src/app/` | Next.js 16 web app and API (App Router). |
| `src/worker/` | Long-running worker (`pnpm worker`): `delivery.ts` (dispatch, deliver, sweep), `db.ts` (owner connection), `index.ts` (pg-boss + LISTEN). Never imported by the web app. |
| `src/lib/recipients.ts` | `resolveRecipients()`: imports only the schema, so the worker can use it. |
| `src/db/schema.ts` | Drizzle schema, including RLS policies. |
| `src/db/index.ts` | `db` client (role `notifyhub_app`) and `withTenant()`. |
| `src/lib/auth.ts` | Better Auth config and `authDb` (role `notifyhub_auth`). |
| `src/lib/permissions.ts` | Permission catalogue, system role ids, `can()`, `loadAccess()`. |
| `src/lib/session.ts` | `requireMember()`: session + company + permissions, or redirect. |
| `src/app/(app)/settings/roles/` | Custom role management (`roles.manage`). |
| `src/lib/invitations.ts` | Create, find, accept and revoke invites. |
| `src/lib/users.ts` | Directory, role assignment, activation, last-admin guard. |
| `src/lib/departments.ts` | Departments, members, managers. |
| `src/app/(app)/departments/` | Department list and detail pages. |
| `src/lib/reminders.ts` | Reminder input validation, recipient resolution, the send-scope check, create/edit/cancel/approve. |
| `src/lib/recurrence.ts` | Repeat rules: occurrences, next/between, plain-language summary, form ↔ rule. Pure, heavily tested. |
| `src/lib/time.ts` | Company-time-zone wall clock ↔ UTC (Intl only, DST-tested). |
| `src/app/(app)/reminders/`, `src/app/(app)/approvals/` | Reminder pages and the approvals queue. |
| `src/lib/test-helpers.ts` | `seeder()` for DB tests: one throwaway company per test file. |
| `src/app/(app)/users/`, `src/app/invite/[token]` | People pages and the public invite accept page. |
| `src/lib/mail.ts` | `sendMail()`: one recipient per message, over SMTP (Mailpit in dev, SES in prod). |
| `src/lib/onboarding.ts` | Creates a company and attaches the signed-in user, in one transaction. |
| `src/components/form.tsx`, `list.tsx` | The UI kit (`Page`, `Section`, `Form`, `Field`, `Button`, `LinkButton`, `List`, `ListRow`, …), each with its own `.module.css`. |
| `src/app/(app)/` | Signed-in pages, wrapped by `layout.tsx`: the app shell (top bar, bottom tab bar). The route group doesn't change URLs. |
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
pnpm worker      # sends reminders; without it they sit "Scheduled" and show "Delayed"
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
- **`requireMember()` is wrapped in React `cache()`.** The app layout and the page
  both call it, and it only runs once per request. Without `cache()` every page
  load would do the session and permission queries twice.
- **The tab bar hides tabs by permission for tidiness only.** Pages enforce access
  themselves.
- **Recurring reminders:**
  - **`reminders.send_at` means "the next occurrence".** The worker,
    `isDelayed` and the list all read it. A series stays `scheduled` and
    `send_at` moves forward after each run;
  - **no drift:** occurrences are always computed from `anchor_local` (the
    series start, wall clock) in `reminders.time_zone`, never from the
    previous occurrence. That's why "monthly on the 31st" goes 30 Apr → 31 May.
    An edit that leaves the start unchanged keeps the old anchor, because the
    edit form shows the *next* occurrence as the start;
  - **catch-up = latest only.** If several occurrences came due while the
    worker was down, only the latest is sent; the others are recorded as
    `missed` (decided with the user: no flood of stale emails);
  - **skip** records a `skipped` occurrence ahead of time. The worker's
    `ON CONFLICT DO NOTHING` on `(reminder_id, occurs_at)` is what stops it
    sending, and resume steps over it.
- **Exactly-once delivery (`src/worker/delivery.ts`):**
  - dispatch turns a due reminder into one `deliveries` row per person.
    `FOR UPDATE SKIP LOCKED` keeps overlapping runs off the same reminder, and
    `unique(occurrence_id, email)` makes a second row for the same occurrence
    impossible (`reminder_occurrences` is unique per reminder and time);
  - each send *claims* its row with `UPDATE … WHERE status='queued'`, so only
    one caller can win;
  - **deliberately at-most-once at the edge:** if the worker dies after SMTP
    accepted a message but before marking it sent, the row stays `sending`. The
    sweep marks it `failed` ("outcome unknown") after 10 minutes and **never
    resends it**. Don't "fix" this into a retry: that's how people get two
    emails.
- **"Now" is immediate via `pg_notify('reminders_due')`,** sent inside the
  transaction that schedules a due reminder (create, edit, approve). The
  worker `LISTEN`s and dispatches at once; the minute tick is only a safety
  net. pg-boss's own queue `notify` wakes the deliver workers.
- **Theme comes from a cookie, read on the server** (`src/lib/theme.ts`). The
  root layout puts `data-theme` on `<html>`, so the first paint is right: no
  flash, no client JS. No attribute means following the device. This is why
  the root layout reads `cookies()`; don't make it static.
- **"Delayed" is derived, not reported.** `isDelayed()` means Scheduled over a
  minute past due, or Sending with no progress for 2 minutes. That only
  happens when no worker is running or it's badly behind. There's no heartbeat
  table to keep in sync.
- **The worker connects as the table owner (no RLS).** Every worker query
  filters by company or by ids it got from a company-scoped row. The test-only
  `dispatchDue(…, onlyCompany)` exists so a test run can't dispatch real dev
  reminders.
- **Reminders store *targets*, not recipients.** "Ops department" stays a
  target, and `resolveRecipients()` turns targets into people at the moment of
  use (PRD 5.2). It filters by `company_id` explicitly as well as through RLS,
  because the worker's connection bypasses RLS.
- **Send scope (`outOfScope`):**
  - holders of `reminders.approve` never need approval;
  - for everyone else, scope is the members of every department they belong to;
  - the whole company, another department, anyone outside scope, or an
    outside email means the reminder waits for approval;
  - the check always runs as the *creator*, even when an admin edits.
- **Approval covers the targets it saw.** Editing an approved reminder keeps
  the approval only if the new targets are a subset of the old ones. Anything
  new goes back to `pending_approval`.
- **Send times are entered in the company's time zone** (`company.timeZone`)
  and stored as UTC. There are no user time zones yet.
- **Invite tokens:** only the SHA-256 is stored. Accepting claims the invite with
  `WHERE accepted_at IS NULL AND expires_at > now()`, so it's single use even
  when two clicks race. Accepting marks the email verified, because the link
  proves the mailbox.
- **`sendOnSignUp` is false on purpose.** `/sign-up` sends the verification email
  itself; otherwise accepting an invite would also send one. Calling
  `signUpEmail` from anywhere else sends nothing.
- **Deactivation is enforced in three places:**
  - Better Auth's `session.create.before` hook blocks every sign-in method;
  - `setActive` deletes the user's sessions;
  - `requireMember()` refuses a deactivated user, covering the moment between
    the two above.

  Don't remove one because "the other covers it".
- **Escalation rule (`canGrant`):** you can grant, remove, or act on a person
  holding a role only if you hold every permission in it. Only admins make or
  unmake admins.
- **Department actions are checked two ways on purpose:**
  - member add/remove calls `can(access, "departments.manage_members", departmentId)`,
    so a manager passes for the departments they manage and nowhere else;
  - rename, delete and make-manager call `can()` *without* a department, so only
    company-wide (admin) permissions count. Passing the department id there
    would not grant managers anything today (those keys aren't in
    `MANAGER_PERMISSIONS`), but one added key would silently let managers
    promote themselves.
- **Last-admin guard:** role and activation changes lock the company row
  (`FOR UPDATE`) and then require at least one active Company Admin. The lock is
  what stops two admins demoting each other at the same moment.
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
