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
| `src/lib/slack.ts`, `src/lib/slack-installations.ts` | Slack Web API client and message builder; the company's connection (encrypted token). |
| `src/lib/crypto.ts` | AES-256-GCM for integration secrets (`ENCRYPTION_KEY`). |
| `src/app/api/slack/{install,oauth}` | "Add to Slack" OAuth (state cookie checked on return). |
| `src/app/api/slack/interactions` + `src/lib/slack-{signature,actions}.ts` | Mark done / Snooze buttons: signature check, then the click handler. |
| `scripts/fake-slack.ts` | **Dev/test only** fake Slack (`pnpm fake-slack`). Never deployed. |
| `src/lib/attachments.ts`, `src/lib/storage.ts` | File rules (content sniffing, CSV formula check, names, limits); the only code touching file bytes. |
| `src/app/api/attachments/[id]` | Download (always as an attachment). |
| `src/lib/comments.ts` | Reminder discussion: comments, replies, mentions, notifications. |
| `src/lib/tasks.ts` | Task completion (`setDone`), progress, my open tasks. |
| `src/lib/time.ts` | Company-time-zone wall clock ↔ UTC (Intl only, DST-tested). |
| `src/app/(app)/reminders/`, `src/app/(app)/approvals/` | Reminder pages and the approvals queue. |
| `src/lib/test-helpers.ts` | `seeder()` for DB tests: one throwaway company per test file. |
| `src/app/(app)/users/`, `src/app/invite/[token]` | People pages and the public invite accept page. |
| `src/lib/mail.ts` | `sendMail()`: one recipient per message, over SMTP (Mailpit in dev, SES in prod). |
| `src/lib/onboarding.ts` | Creates a company and attaches the signed-in user, in one transaction. |
| `src/components/form.tsx`, `table.tsx`, `list.tsx` | The UI kit (`Page`, `Section`, `Form`, `Field`, `Button`, `LinkButton`, `Table`, `Badge`, `List`, …), each with its own `.module.css`. |
| `src/app/(app)/` | Signed-in pages, wrapped by `layout.tsx`: the app shell (left sidebar; a top bar below 768px). The route group doesn't change URLs. |
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
pnpm fake-slack  # dev: a fake Slack on :4999 (the .env SLACK_* values point at it)
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
- **The sidebar hides links by permission for tidiness only.** Pages enforce access
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
- **Slack:**
  - one workspace per company (`slack_installations`, `team_id` unique);
  - the bot token is AES-GCM encrypted, decrypted only right before a call,
    and never logged or sent to the browser;
  - a DM delivery's `address` is the internal user id, looked up in Slack by
    email at send time. Someone with no Slack account goes to the company's
    fallback channel (with a note), or fails if there isn't one;
  - **the whole company on Slack goes to channels only**, never one DM each
    (PRD 5.3);
  - for non-approvers, a Slack channel always counts as out of scope (its
    audience isn't known), so it needs approval;
  - permanent Slack errors (channel gone, token revoked) fail at once; 429s
    retry.
- **Comments (PRD 5.11):**
  - anyone who can see the reminder (`reminderAccess`) can comment; threads
    are one level deep (a reply to a reply joins the thread);
  - **mentions are explicit ids** from the composer
    (`mention-textarea.tsx`). The server keeps an id only if it's a company
    member **and** their `@Name` is still in the text. The body stays plain
    text; highlighting is rendered as text segments, never HTML;
  - **a mention only notifies people who can see the reminder** (checked per
    person). Others are reported back to the commenter, so a mention never
    leaks a reminder. Edits notify only newly added mentions;
  - deletes are soft (body cleared; "Comment deleted" keeps replies in
    context). The author, or `comments.delete_any` (admins), can delete;
  - mention notifications go by email, plus a Slack DM if connected (no
    in-app notification centre yet).
- **Attachments (PRD 5.7):**
  - **file bytes live in Postgres** (`attachment_blobs`, bytea; decided with
    the user), separate from `attachments` metadata, and touched only by
    `src/lib/storage.ts`. Moving to S3 is a new version of that file;
  - a file is accepted only if its **bytes** match its extension (magic
    bytes; OOXML must contain `[Content_Types].xml`). The browser's
    Content-Type is ignored, and we serve the sniffed type;
  - **CSV:** any cell starting `= + - @` (or tab/CR) is refused unless it's a
    plain number or a `+…` phone number;
  - **downloads** need same-company (RLS) **and** reminder visibility
    (`reminderAccess`), and are always `Content-Disposition: attachment` with
    `nosniff`, so an uploaded HTML-ish `.txt` can never run on our origin;
  - **email** attaches in upload order up to 20 MB and names the rest. Files
    saved together keep their order because `created_at` is
    `clock_timestamp()`, not `now()`;
  - **Slack** uploads into the message's thread *after* posting. A failed
    upload is noted on the delivery, never retried (that would re-post the
    message). It needs the `files:write` scope. `chat:write.public` lets the
    bot post to a channel it hasn't joined, but files need it inside, so on
    `not_in_channel` it joins (`channels:join`, public channels) and retries
    once. Older connections show "Reconnect Slack".
- **Slack buttons:**
  - **the signature is checked first, on the raw body** (`verifySlackSignature`: HMAC plus a 5-minute timestamp window). Without it anyone could POST a fake "Mark done";
  - a button's `value` is the **occurrence**, never a person. The clicker is
    mapped Slack user → email (`users.info`) → NotifyHub user, and must be an
    assignee of that occurrence. So the same buttons are safe in shared
    channel posts, and nobody can act for someone else;
  - the click's database change happens before we answer Slack; message
    updates and ephemeral replies run in `after()` (Slack's 3-second limit);
  - **snooze** sets `task_assignments.snoozed_until`. The minute tick claims
    due snoozes by clearing the field in the same UPDATE, and re-sends the DM
    once (the job has no retries, on purpose).
- **Daily Slack digest (`src/worker/digest.ts`):**
  - once per company per local day at `digest_time`, claimed exactly like
    follow-ups (`last_digest_on`);
  - the content is company-wide (overdue tasks with someone not done, plus
    reminders going out in the next 24h), and goes only where an admin points
    it;
  - each destination is independent; no retries, at most one a day.
- **Task follow-ups go over the task's channels:** email first (a failure
  retries), then a Slack DM whose failure is only logged, so a Slack problem
  never causes a second email.
- **Deliveries are per (occurrence, channel, address).** One person can get
  an email and a Slack DM for the same occurrence. That's why task completion
  moved off `deliveries`.
- **Tasks (PRD 5.8):**
  - completion is `task_assignments.done_at`: one row per (occurrence,
    internal user) whatever the channels, so each occurrence of a repeating
    task starts fresh with no reset job;
  - assignees are internal recipients; outside emails get the task email but
    aren't tracked;
  - the due time is stored as an offset (`due_after_minutes`), and each
    occurrence gets `due_at = occurs_at + offset`.
- **Task follow-ups:**
  - once per local day at `companies.follow_up_time`, for anyone overdue at
    that moment and not done;
  - `claimFollowUps` stamps `task_assignments.last_followup_on` with the company-local date in
    the same UPDATE that selects. That stamp is the once-a-day guarantee, so
    don't split it into a SELECT and then an UPDATE;
  - email only (there's no in-app notification centre yet).
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
- **Preview, test and real sends share one email builder** (`src/lib/email-render.ts`,
  pure, so the browser preview imports it too); Slack uses `reminderMessage`
  for all three. Change the message there, not in the worker.
- **Send now:**
  - a one-time reminder just has `send_at` moved to now, and the normal
    dispatch sends it;
  - a recurring one gets `send_now_at` set; the worker's `dispatchManual` turns
    that into one extra occurrence at exactly that time and clears it.
    `send_at` (the next scheduled one) is never touched. The unique
    `(reminder_id, occurs_at)` makes a double run harmless.
- **"Send me a test" isn't a delivery.** It sends from the web process, to the
  clicking user only, and writes no `deliveries`, occurrences or task rows, so
  it never shows in counts, history or follow-ups.
- **Notifications (PRD 7.5) are rows written when the event happens**, in the
  same transaction as the event where possible (the occurrence, the decision,
  the task update). A `dedupe_key` (`occ:`, `done:`, `failed:` + occurrence id)
  makes repeatable writers (worker retries, undo/redo) insert once.
- **Preferences are opt-out rows** (`notification_mutes`; no row = on), and
  they only cover NotifyHub's own messages: approvals, decisions, mentions.
  Reminders and tasks always arrive the way the sender chose (decided with the
  user). In-app is always on.
- **Opening a notification goes through `GET /notifications/[id]`**, which
  marks it read and redirects. The sidebar count is rendered by the layout,
  which runs alongside the page, so marking read inside the reminder page
  would leave the count stale for that load. The list uses a plain `<a>` (no
  prefetch), so only a real click marks it read.
- **Two visibility levels, each with an SQL twin for lists** (PRD 5.4, 8):
  - **full** (`canSeeReminder` / `overseeWhere`): the creator, everyone with
    `view_all`/`approve`, and managers of the creator's departments. They see
    the delivery log and owner actions. Dashboard counts use this.
  - **viewer** (`reminderAccess` = "viewer" / `canViewWhere`): also anyone it
    was sent to, or shared with (the whole company, a department or a group
    they're in). They can read, download attachments and comment. Lists,
    search and the calendar use this, so anything you can open you can find.
  - Change a function and its twin together (`src/lib/reminders.ts`,
    `src/lib/views.ts`).
- **Sharing never needs approval:** it's about who sees, not who receives.
  "My departments" is expanded to department ids when saved, so the saved
  list is explicit.
- **List filters live in the URL** (a GET form, no client JS): every view is
  deep-linkable and the back button works. `parseFilters` drops anything
  unknown instead of erroring. Search is `ilike` with `%`/`_` escaped, and
  paging is offset-based, which is fine to a few thousand reminders per
  company; beyond that, use `pg_trgm` and keyset paging.
- **The dashboard's numbers match the lists they link to.** Each card's link
  is the filter for exactly what it counts (same SQL conditions). Change them
  in pairs.
- **The calendar expands series from their rule** (`between()`), from the next
  occurrence, minus recorded (skipped) ones, up to 500 scheduled reminders
  per request.
- **Groups (PRD 4)** resolve to their active members at send time, like
  departments. Anyone with `groups.create` (given to the Member role by
  migration 0021) makes one; the creator or `groups.manage` edits it.
  - **Adding members re-checks scope** (`recheckGroupReminders`). A member
    could otherwise send to an in-scope group and widen it later. Any upcoming
    reminder to the group whose creator couldn't reach a newly added person
    goes back to "Needs approval", and approvers are told.
  - **A group can't be deleted while an upcoming reminder uses it**, so a
    schedule never silently loses its recipients.
- **2FA (PRD 3.1) is Better Auth's twoFactor plugin.** Its `two_factor` table
  holds encrypted TOTP secrets and backup codes, so, like `session` and
  `account`, only `notifyhub_auth` is granted it (migration 0022). The
  default privileges from 0001 would otherwise give it to the app role.
  - **It only challenges email/password sign-ins.** Google sign-in relies on
    Google's own 2-step. "Require 2FA" still makes Google users set up TOTP
    before using the app.
  - **The require-2FA gate is in `requireMember()`.** Every page and server
    action redirects to `/settings/security?required=1` until 2FA is on. Only
    the security page and its actions (and the app shell) pass
    `requireMember(true)`.
  - **Setup shows the secret and backup codes once,** passed to the next render
    in a 10-minute httpOnly cookie scoped to `/settings/security` and deleted
    on confirm. The QR is an SVG rendered on the server (`qrcode`).
- **Password reset** (`/forgot-password`) answers the same for unknown emails
  and sends the email without waiting (timing). Links are single use, last
  1 hour, and a reset signs out every session.
- **A personal time zone (`user.time_zone`) is for display only:** the
  dashboard, lists, notifications, calendar and approvals. Reminders keep
  their own zone for scheduling, and the form still defaults to the
  company's.
- **The audit log (PRD 9.1) is written by a Postgres trigger, `audit_row()`
  (migration 0024), on each audited table,** so a new write path can't forget
  it.
  - **The actor flows:** `requireMember()` → `setCurrentActor()` (keyed on the
    request's `headers()` object; React `cache()` isn't request-scoped in
    server actions) → `withTenant()` → transaction-local `app.actor_id`.
  - **Only people's actions are logged.** With no actor (the worker, tests,
    Better Auth internals) the trigger records nothing. Slack button clicks
    set the clicker as the actor in `handleTaskAction`.
  - **Secrets are kept out by the trigger's excluded-column arguments**
    (`bot_token_enc`, `token_hash`, …). **A new secret column on an audited
    table must be added there.** `session`/`account`/`two_factor` aren't
    audited at all.
  - **Append-only and unforgeable:** the app role can only `SELECT`
    `audit_log` (through RLS). The trigger is `SECURITY DEFINER`.
  - **Known noise:** editing a reminder re-creates its recipients and shares,
    so they show as delete + create pairs.
- **Report definitions (PRD 10, `src/lib/reports.ts`), all in the viewer's time
  zone:**
  - **Deliveries:** a delivery counts at its `sent_at`, or its last update if
    it never sent. Success rate = sent ÷ (sent + failed); pending isn't
    counted either way.
  - **Tasks:** counted by their occurrence's due date. "On time" = done
    by the due time. Time to complete = done minus when it was sent.
  - **Grouping:** someone in two departments or groups counts in each.
  - **Overdue:** the current state (open and past due), whatever the date
    range.
  - The page and the CSV export build the same table (`reports/data.ts`), so
    they can't disagree.
- **Rate limits (PRD 11.1):**
  - **Better Auth's limiter only guards its HTTP routes** (`/api/auth/*`).
    Our sign-in, sign-up, 2FA, reset and invite forms are server actions
    calling `auth.api.*` directly, which **skips it**. So they're limited by
    `src/lib/rate-limit.ts`: a fixed window in Postgres (`rate_limits`),
    keyed per account and per IP.
  - **It fails closed:** if the store can't be reached, the action is
    refused ("briefly unavailable").
  - Better Auth's own routes use `storage: "database"` (table `rate_limit`)
    and are always on.
  - The worker clears day-old windows.
- **Reset tokens and 2FA challenge ids are stored hashed**
  (`verification.storeIdentifier: "hashed"`). Invitations already store a
  hash; email verification is a signed JWT.
- **CSP with a per-request nonce, set in `src/proxy.ts`.** Next puts the
  nonce on its own scripts; anything else inline is blocked.
  `style-src-attr 'unsafe-inline'` is only for `style=""` attributes (report
  bars). The other hardening headers, `X-Robots-Tag` and HSTS (https only)
  are in `next.config.ts`; `robots.txt` disallows everything.
- **`/api/health`:** 200 when the database answers and the worker ticked in
  the last 3 minutes (`worker_heartbeat`), otherwise 503. No auth, nothing
  sensitive.
- **Startup checks:** the web (`src/instrumentation.ts`) and the worker run
  `checkEnvironment()`. With `NODE_ENV=production` they **exit** on unsafe
  config (short secret, http outside localhost, bad encryption key,
  superuser or BYPASSRLS app role, missing SMTP, fake-Slack overrides,
  half-configured Slack or Google). In dev they only warn.
- **Approvers (PRD 9.1):** `approverIds()` in `src/lib/reminders.ts` is the
  one rule.
  - Mode `any`: everyone active with `reminders.approve`.
  - Mode `named`: the `company_approvers` among them. **If none of the named
    ones still qualifies, it falls back to everyone**, so approvals never
    get stuck.
  - `decideReminder` enforces it itself (`mayDecide`); the UI just hides the
    buttons. Visibility doesn't change: approvers still see everything.
- **CSV import of people** (`importInvitations`) is all-or-nothing.
  - Any bad row means nothing is created, and every problem is listed.
  - Existing members are skipped, not errors.
  - Roles follow the same "can't grant above yourself" rule as single
    invites.
  - Invite emails go out after the response (`after()`).
- **Data retention** (`src/worker/retention.ts`, nightly at 03:00 UTC):
  - deletes **finished** reminders (sent, cancelled, rejected) untouched
    for the period, with everything that cascades from them;
  - deletes older notifications and audit entries;
  - never touches upcoming or active reminders;
  - each purge writes one "System" audit row with the counts.
- **The platform-owner console (`/platform`, PRD 9.2):**
  - **Owners** are the accounts in `PLATFORM_OWNER_EMAILS`. They must have
    2FA on, and must come from `PLATFORM_ALLOWED_IPS` (in dev with no list,
    localhost only). Anything else gets a 404; an owner without 2FA is told
    to set it up at `/account/security`, which works without a company.
  - **Cross-company reads don't use the owner connection.** They go through
    `SECURITY DEFINER` functions (`platform_companies`, `platform_queue`,
    `platform_set_member_role`, migration 0027) that return aggregates only,
    and refuse unless `app.platform = 'on'` was set in the transaction.
    Only `src/lib/platform.ts` sets it, after the owner check.
  - **Per-company changes** (edit, suspend, delete) go through `withTenant`
    with the owner as actor, so they show in that company's audit log.
  - **Suspension** sends the company's people to `/suspended` and makes every
    worker claim skip the company. Deliveries already queued at that moment
    may still go out.
  - **Delete** works only when the company is empty; the foreign keys
    enforce it.
- **Privacy (PRD 11.5):**
  - **Export:** "Export their data" on a person (admin, same "not above you"
    rule) and "Download my data" in Profile give a JSON of everything held
    about them, never tokens or secrets.
  - **Erase:** "Erase permanently" on a deactivated person runs
    `erase_person()` (migration 0028), a `SECURITY DEFINER` function shared
    by the web and the nightly retention job. It removes their name, email,
    login, 2FA, sessions, memberships and comment texts, and scrubs them from
    the audit log; the row stays as "Deleted person", so reminders they
    created keep working. The scrubbing writes no audit rows (no old values
    leak into the log); only `erased_at` is recorded, against the admin.
  - **Auto-erase:** with a retention period set, people deactivated longer
    than it are erased nightly.
- **Guided setup (`/setup`, PRD 3.1):** onboarding lands there. Each step
  (departments, invites, a manager per department, plus optional Slack and a
  first reminder) is **computed from the real data** (`setupStatus`), so doing
  it anywhere in the app counts and nothing can drift. Only "dismissed" is
  stored. Home shows "Finish setting up" to admins until it's complete or
  dismissed.
