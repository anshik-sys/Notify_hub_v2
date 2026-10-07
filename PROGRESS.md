# Progress

Daily log, newest first. Committed, not gitignored, so worktrees merge it.

## 2026-10-07 — tasks with due dates and daily follow-ups

- **What's in place:**
  - "This is a task" plus a due date and time on the reminder form;
  - emails titled "Task: …" with the due time;
  - each assignee marks done or undoes on the reminder page;
  - owners see "N of M done" with per-person status (Done / Not done /
    Overdue) and follow-up counts;
  - "Your open tasks" on Home;
  - daily "Overdue: …" emails at the company's follow-up time
    (`/settings/company`, admins).
- **Completion on the delivery row,** not a separate table. One row per
  person per occurrence already exists, so a repeating task starts fresh by
  construction, and "only your own" is just `user_id = me` (plus RLS).
- **The due time is stored as an offset** from the send, so a repeating task
  stays due "the same time after it's sent" every time. One form field: the
  due time, entered as a date and time.
- **Follow-ups:**
  - one SQL UPDATE per tick claims each overdue, undone assignee once per
    company-local day (`last_followup_on`), with the slot computed in the
    company zone in SQL. A second tick or worker that day matches nothing;
  - the job re-checks "done" before sending, so marking done just after the
    claim still stops the email;
  - a follow-up is only sent if the task was overdue at the slot time: due at
    10:00 with a 09:00 slot means the first follow-up is the next morning.
- **Test isolation:** `claimFollowUps` takes the same test-only scope as
  `dispatchDue`. Without it, a test run at 2042 dates would stamp real dev
  deliveries' `last_followup_on` and silence their real follow-ups until 2042.
- **Deferred:**
  - manager escalation after N days (PRD: optional);
  - in-app and Slack follow-ups;
  - the shared done toggle for external-only tasks;
  - "mark complete" on non-task reminders;
  - a `/tasks` page.
- **Verified against `next start` + `pnpm worker` + Mailpit:**
  - "Task:" emails; the owner sees 0 of 2; the assignee sees only their own
    status;
  - carol marking bob's task → refused, nothing written;
  - bob done → 1 of 2, and it leaves his open tasks;
  - forced follow-up time: carol got exactly one "Overdue:" and bob (done) none;
  - the next tick that day sent nothing;
  - company settings: admin only, and an invalid time is refused.

  43 tests pass, including the follow-up slot in Asia/Kolkata, once a day,
  stopping on done, and skipping deactivated users.
- **Not checked:** the task section and buttons on a phone.

## 2026-10-07 — theme switch (system / light / dark)

- **Why:** the user asked for a light theme. The light colours already
  existed, but the app only followed the device setting, so on a dark-mode
  device light was unreachable. PRD 8 wants a remembered choice that follows
  the system by default.
- **How:** a `theme` cookie (1 year, per device), read in the root layout,
  which sets `<html data-theme>`. The CSS dark tokens apply under
  `prefers-color-scheme: dark` unless the theme is `light`, and always under
  `data-theme="dark"`. `color-scheme` is set, so date pickers and selects
  match.
- **Rejected:** localStorage with a client script. It flashes the wrong theme
  before hydration and needs an inline blocking script. The cookie costs
  nothing, since every page is already server-rendered per request.
- **The switch** is a segmented control (System / Light / Dark, 44px buttons,
  `aria-pressed`) on Home under "Appearance". It's a plain form posting to a
  server action, with no client JS.
- **Verified against `next start`:**
  - with no cookie there's no attribute (the device decides);
  - Light, Dark and System each set or clear the attribute on Home,
    Reminders and the sign-in page, and the pressed button matches;
  - a bogus value is ignored;
  - the compiled CSS contains `:root:not([data-theme=light])` inside the
    dark media query, and `:root[data-theme=dark]`.

  **Not checked:** how it looks. That's for the user, in the browser.

## 2026-10-07 — recurring reminders

- **What's in place:**
  - presets: daily / weekdays / weekly / monthly / annually;
  - custom: every N days, weeks, months or years; weekdays; monthly by date,
    by Nth weekday, or by last weekday; ends never / on a date / after N;
  - pause / resume / skip next;
  - a plain-language summary and "Next: …";
  - occurrence history (sent / missed / skipped).
- **Decided with the user:**
  - catch-up sends only the latest missed occurrence; the rest are recorded
    "missed";
  - edits apply to the whole series. "Change just one occurrence" is deferred.
- **No drift:** every occurrence is computed from the anchor, never from the
  previous one. `src/lib/recurrence.ts` tests:
  - 31st → 28/29 Feb → 31 Mar → 30 Apr → 31 May;
  - 3rd Tuesday; last Friday in 4- and 5-Friday months;
  - 29 Feb → 28 Feb → 29 Feb;
  - 09:00 New York held across both 2026 DST changes; a 02:30 daily on the
    gap day moves to 03:30 for that day only.
- **Data:** `send_at` became "next occurrence", so the worker loop,
  `isDelayed` and the list needed no new concept. A new
  `reminder_occurrences` table (unique per reminder and time) and
  `deliveries.occurrence_id` change exactly-once to (occurrence, person).
  Migration 0009 was hand-edited to backfill; checked against the 3 real dev
  reminders and 5 deliveries.
- **Two bugs found while building:**
  - the edit form shows the next occurrence as the start, so saving any edit
    would have re-anchored "monthly on the 31st" to the 30th. An unchanged
    start now keeps the original anchor (tested);
  - resume after skip showed the skipped occurrence as "Next". The worker
    wouldn't have sent it, but the page was wrong. Resume now steps over
    recorded occurrences (tested + E2E).
- **Verified against `next start` + `pnpm worker` + Mailpit:**
  - a daily "Now" sent once, with next tomorrow;
  - a simulated 3-day outage → 3 missed + 1 sent, bob got exactly 1 email,
    and next is back in the future;
  - another user can't pause the series;
  - skip / pause / resume;
  - a paused, overdue reminder is not "Delayed";
  - the custom rule summary in the list; edit pre-fills the custom fields.

  39 tests pass.
- **Not checked:** the Repeat section's look on a phone (the select, the
  "Custom repeat" disclosure, the side-by-side "Every [n] [unit]" row). The
  custom fields are always visible inside the disclosure: no JS, so they don't
  hide when another preset is chosen.

## 2026-10-07 — "delivery is delayed" safeguard

- **What happened:** the user created a "Now" reminder and it stayed
  "Scheduled". The engine was fine: the worker wasn't running, because it
  was stopped after the last test and nothing in the UI said so.
- **Fix:** `isDelayed()` flags a reminder as Scheduled over 60s past due, or
  Sending with no update for 120s. The list badge reads "Delayed" and the
  detail page shows a warning saying it'll go out automatically, once.
  - We rejected a worker heartbeat table: more moving parts, and it can only
    say "no worker", while the derived check also catches a worker that's
    alive but stuck.
  - The 60s threshold: the worker normally sends within a second, and its
    minute tick is the backstop.
- **Tests no longer depend on whether a worker is running:**
  - a live worker broke the lifecycle test by sending its "now" reminder
    mid-test;
  - fixed with test send times an hour ahead, plus a test-only `now` argument
    to `dispatchDue`.
- **Verified against `next start`:**
  - worker stopped + a 2-minute-overdue reminder → "Delayed" badge and the
    warning;
  - worker started → sent, and the warning is gone.

  24 tests pass.

## 2026-10-07 — reminders send for real; edit fix; recipient picker

- **What the user reported:**
  - "Now" didn't send. Expected: delivery wasn't built yet;
  - edit needed checking. A real bug: the edit page always pre-picked "At a
    set time" with the original time, so a pending or rejected "Now" reminder
    couldn't be resubmitted ("Pick a time in the future");
  - recipients needed per-teammate ticking and a searchable people dropdown.
- **Delivery engine (0008 `deliveries`, `src/worker/delivery.ts`):**
  - dispatch: SKIP LOCKED + `unique(reminder_id, email)`;
  - the send claims its row; up to 5 attempts with pg-boss backoff, then
    `failed`;
  - the sweep fails stuck `sending` rows and **never resends them**. We
    rejected at-least-once: a retry after an SMTP timeout is exactly how a
    person gets the same reminder twice.
- **"Now" means now:** the web app runs `pg_notify('reminders_due')` in the
  scheduling transaction, and the worker LISTENs. Approving an overdue
  reminder fires it the same way.
  - First measurement: 3.8s for 2 people and **10.3s for 5**, because pg-boss
    polls every 2s and ran one job at a time.
  - Fixed with pg-boss queue `notify` and `localConcurrency: 10`: **0.2s for a
    5-person company-wide send.**
- **Recipients can open what they received** (`reminderAccess` →
  "recipient"). They see the reminder, but not the recipient list or the log.
  Owners get a delivery log ("5 sent · 0 failed · 0 pending" plus per-person
  rows).
- **Recipient picker:**
  - your departments show as open sections with "Everyone in X" plus each
    teammate as a tick;
  - other departments are whole-department choices marked "need approval";
  - people is a searchable combobox (`people-picker.tsx`, the second client
    component), with chips carrying hidden inputs and a `<noscript>`
    multi-select fallback;
  - teammates pre-fill as ticks, not chips, so edit doesn't show them twice.
- `resolveRecipients` moved to `src/lib/recipients.ts` (schema-only imports)
  so the worker doesn't load the web app's DB client.
- **Verified against `next start` + `pnpm worker` + Mailpit:**
  - ticked teammates both got "Now" within seconds, each To only themselves,
    From "… via NotifyHub", Reply-To the creator, with the link;
  - whole company → pending, no mail → approve → all 5 sent;
  - recipient 200 (no log); non-recipient 404;
  - a rejected "Now" edit reopens as "Now" and resubmits → approve → sent;
  - worker down → stays Scheduled → restart sends once;
  - **exact-subject Mailpit count: every reminder reached each person exactly
    once across two restarts.**

  23 tests pass, including parallel dispatch, a double claim, retries → failed,
  and the sweep.
- **Side effect in the dev DB:** the first worker start sent 2 "Now" reminders
  the user had created while testing phase 1. That's the intended catch-up
  behaviour.
- **Not checked:** the picker's look and feel on a phone (search, chips,
  department sections), and a real SES send.

## 2026-10-07 — reminders phase 1: create, scope, approval

- **What's in place:**
  - `reminders` and `reminder_targets` (0007);
  - `/reminders` list, new, detail, edit, cancel;
  - `/approvals` queue; approve or reject (a reason is required, and the
    creator is emailed); approvers are emailed on submit;
  - a Reminders tab, and "Approvals waiting (N)" on home.

  **Nothing sends yet.** The worker comes in phase 2.
- **Targets, not recipients, are stored.** They're resolved at use time
  (PRD 5.2). One `resolveRecipients()` serves both the scope check and (next)
  the worker, so the two can't disagree about who gets it.
- **Scope check** follows PRD 5.2. Department targets the sender isn't in are
  flagged by name, and resolved people by email. That's what the "needs
  approval" banner shows.
- **Approval-widening rule:** editing keeps an approval only if the new
  targets are a subset of the old ones. We rejected comparing resolved people,
  because membership changes between approval and edit would flip the result
  for reasons the editor can't see.
- **Time zones:** `src/lib/time.ts` uses only Intl. A DST gap moves forward and
  an overlap takes the earlier time (Temporal "compatible"); tested on New York
  2026 transitions. Inputs are in the company zone.
- **`sendMail` takes an options object** (several links, `fromName`,
  `replyTo`). The from-*address* never changes, only its display name.
- **`requireMember()` also returns the company** (name, time zone). The layout
  already queried it, so it's still one query per request.
- **Known gap:** a validation error on the reminder form redirects back and
  loses what was typed. Accepted for now: no client JS, and `required` covers
  most cases. Fix with `useActionState` if it bites.
- **Verified against `next start` + Mailpit with curl:**
  - in-scope → Scheduled; out-of-scope → Needs approval, with the admin
    emailed and the banner naming Sales and carol;
  - 09:30 Asia/Kolkata is stored as 04:00 UTC;
  - `<b>` and `<script>` in title and description render escaped;
  - visibility: creator, manager and admin 200; another department's member 404;
  - **direct calls:** alice approving her own reminder → 404; carol cancelling
    or editing alice's → refused, nothing written;
  - reject without a reason is refused; with one, alice gets the email;
  - resubmit → pending; approve → scheduled with `decided_by`; cancelled →
    the edit page is 404.

  19 tests pass.
- **Script lesson:** the first run lost a test user to Better Auth's sign-up
  rate limit (more than 3 sign-ups in 10s from one IP). The rate limit working
  is correct; the script now spaces them.

## 2026-10-07 — mobile-web restyle, departments on home

- **Why:** the user pointed out that the screens were designed like a desktop
  website (a narrow centred column, small text-link actions), but the product is
  used as a mobile web app.

  There was no written rule, so I decided one and recorded it in `AGENTS.md`:
  mobile first, 48/56/44px touch targets, an app shell with a bottom tab bar,
  back links at the top, and screens built only from the kit.
- **Structure:**
  - signed-in pages moved into the `(app)` route group (URLs unchanged) so they
    share `layout.tsx`;
  - the UI kit moved to `src/components/` with an `@/` import, because the move
    broke the relative imports. That also prevents it happening again;
  - `FormPage` was renamed `Page`, and gained `back` and `center`;
  - new `Section`, `LinkButton`, and `List`/`ListRow`, which replace three copies
    of list CSS in the users, departments and roles pages.
- **First client component:** `nav-link.tsx`, needed only for `usePathname()`
  to mark the active tab. Everything else stays server-rendered.
- **`requireMember()` is now `cache()`d**, since the layout and the page both
  call it.
- **The home page** shows "Your departments" (with a Manager badge), your roles,
  and sign-out. Its old links moved to the tab bar.
- **Verified against `next start` with curl:**
  - every page returns 200 for the admin;
  - the manager gets 404 on invite and roles pages;
  - tab sets per role are right; the active tab is marked on sub-pages;
  - the manager's home shows Ops as Manager, and Ops shows them add/remove only;
  - the viewport meta carries `viewport-fit=cover`.

  12 tests pass. **Not checked visually.** That's the user's call on a phone: the
  tab bar over the iPhone home indicator, row actions wrapping, and dark mode.

## 2026-10-07 — departments, managers, members (phase B)

- **What's in place:**
  - `/departments` list and create;
  - `/departments/[id]` with members, add/remove, make/unmake manager, rename,
    and delete;
  - invites can place people in departments;
  - a person's page lists their departments.
- **Managers are chosen only by admins.** Make-manager checks
  `departments.edit` with no department argument, so manager permissions never
  apply to it. That guards against a future `MANAGER_PERMISSIONS` change letting
  managers promote themselves.
- **Invite acceptance adds memberships through `authDb`.** Migration 0006
  grants it SELECT on departments (scoped by the tenant setting accept already
  sets) and INSERT on `department_members`. Departments deleted between invite
  and accept are skipped, and an invitee never joins as a manager.
- `SelectField` now takes `{ value, label }` options as well as plain strings.
- **Verified against `next start` + Mailpit with curl:**
  - the admin creates departments; a duplicate name is refused;
  - an invite into Ops lands the new user in Ops;
  - the admin makes them manager of Ops;
  - **calling the actions directly as that manager:** add/remove in Ops goes
    through; adding to Sales, making anyone manager, rename, delete and create
    all get 404;
  - **as a plain Member:** every action gets 404, and a bad uuid gets 404;
  - the final DB state matches exactly, and the admin's delete works.

  12 tests pass.

  **Not checked:** the browser layout of the department pages and the
  department checkboxes on the invite form.
- **Dead end, script only:** the first E2E run got 500s everywhere because
  `eval` in the test script expanded `$ACTION_ID_…` field names into empty
  strings. It wasn't an app bug. Fixed with quoting, plus a 30-second cap on
  waiting for mail.

## 2026-10-07 — invites, people list, role assignment, deactivation (phase A)

- **Invites:**
  - the token is hashed at rest;
  - claiming it is single use and race-safe (conditional UPDATE);
  - expires after 7 days;
  - re-inviting replaces the pending invite (partial unique index).

  Accepting marks the email verified. The accept page handles three cases:
  new account, signed in as the invitee, and existing account signed out
  (→ `/sign-in?next=`, open-redirect-safe).
- **`sendOnSignUp` turned off**, and `/sign-up` sends explicitly. Without this,
  creating the invitee's account would send a pointless verification email.
  Re-checked: the sign-up page still sends it.
- **Deactivation has three layers** (session hook, session delete, check in
  `requireMember`). The app role can't touch `session`, so the guard and the
  update run in one app-role transaction, and the session delete runs right
  after on `authDb`. Not atomic. Accepted because `requireMember` refuses the
  user in that window.
- **Escalation rule:** you can only grant, remove, or act on people whose roles
  you could grant. Without it, a custom role with `users.manage_roles` could
  hand out Company Admin.
- **Last-admin guard** uses a per-company `FOR UPDATE` lock. Without the lock,
  two admins demoting each other at once would both pass the count.
- **Shared `CheckboxGroup`**: the roles form switched to it, and
  `role-form.module.css` was removed (its styles moved into
  `form.module.css`).
- **Verified against `next start` + Mailpit with curl:**
  - sign-up still emails;
  - an admin invites, the email arrives, the accept form creates the account,
    which lands in the company verified with Member, and the reused link is
    refused;
  - as a Member, direct calls to invite, grant self admin, and deactivate the
    admin each get 404 with no write;
  - the admin demoting themselves as the last admin is refused;
  - deactivating deletes sessions, bounces the open session, and sign-in says
    "deactivated"; reactivating restores sign-in;
  - `?next=//evil.com` falls back to `/`.

  11 tests pass (Mailpit must be running).

  **Not checked:** browser layout; the "existing account → sign in → accept"
  path end to end (its pieces are tested separately).

## 2026-10-07 — roles and permissions

- **What's in place:**
  - the permission catalogue in code;
  - `roles` (system roles have `company_id` NULL), `user_roles`, and
    `department_members.is_manager`;
  - `can()` / `loadAccess()` / `requireMember()`;
  - the onboarding creator becomes Company Admin; migration 0004 backfilled
    existing companies;
  - `/settings/roles` to create, edit and delete custom roles.
- **Company Admin is "everything" in code, not in its row.** We rejected storing
  the full list, because every new permission would then need a data migration,
  and forgetting one would silently lock admins out of a feature.
- **Manager permissions are a fixed list in code**, applied per managed
  department. We rejected a configurable department-scoped role: no customer
  has asked, and it doubles the `can()` logic. Marked `ponytail:`.
- **System roles are protected by RLS plus explicit checks.** The tenant WITH
  CHECK can't match NULL, so the app role can't edit, delete or create them
  (tested). The actions also scope writes by `company_id`. Both layers are kept
  deliberately.
- **Delete confirmation is a required checkbox**, not a JS `confirm()`, so the
  page stays free of client JS.
- **Verified against `next start` with curl:**
  - an admin sees the Roles link, the list, a read-only built-in role and the
    new-role form;
  - a malformed or unknown id gets 404;
  - after a downgrade to Member, the link is gone and every roles URL is 404;
  - signed out redirects to sign-in;
  - calling the create action directly: an admin creates a role, while a
    duplicate name, a built-in name and an unknown permission are each refused;
  - **as a Member, the direct action call gets 404 and writes nothing.**

  **Not checked:** the edit and delete actions by direct POST (covered by the
  same `requireRoleManager()` path, plus RLS), and the pages in a browser.
- **Not built yet:** assigning roles to users, picking managers, and last-admin
  protection. All of these wait for user management and invites.

## 2026-10-07 — tailwind replaced with css modules

- **Why:** with Tailwind, an element in devtools is a wall of utility classes,
  and you can't tell which component it belongs to. With CSS Modules, each
  component's styles live in one `.module.css` file beside it, and the inspector
  shows `form-module__<hash>__field`.
- **Rejected:** plain global CSS files. One namespace for the whole app means
  `.title` in two components collide, and rules leak between them. CSS Modules
  are built into Next.js and need no extra setup.
- Removed `tailwindcss`, `@tailwindcss/postcss` and `postcss.config.mjs`.
  Colours moved to CSS variables in `globals.css`, with dark-mode overrides.
- **Checked:** the compiled HTML from `next start` carries the module class names.
  Values were ported 1:1 from the Tailwind classes (zinc palette, 6px radius,
  16px input font), so pages should look the same. **Not checked visually**:
  that's for the user, in the browser.

## 2026-10-07 — email sending and email verification

- **Closes the domain-claim hole** from the auth entry below. Before this,
  anyone could sign up as `x@acme.com` and own the acme.com company. Now sign-in
  requires a verified email, and `createCompany` checks `emailVerified` again.
- **SMTP only, via nodemailer.** Mailpit in dev, SES's SMTP endpoint in prod.
  Same code path, and only the URL differs. We rejected the SES SDK for now
  because nothing needs the API yet. It will be needed for per-company domain
  verification (PRD 7.1 tier 2) and bounce handling. **SES itself is
  unverified:** there's no AWS account set up, so only Mailpit has been tested.
- **The verification send isn't awaited**, so sign-up timing doesn't reveal
  registered emails. Measured: 72 ms for an existing email vs 68 ms for a new one,
  identical response shape. Trade-off: a failed send is only logged. Signing in
  again resends (`sendOnSignIn`).
- **Deviation from PRD 11.1 ("tokens never in URLs"):** an email link has to
  carry a token. Better Auth's is a stateless JWT (1 hour), so it isn't
  single-use. Checked: reusing a link after verification redirects but creates
  no session. Revisit if we need early revocation.
- **Verified end-to-end against `next start` + Mailpit with curl:**
  - sign-up returns no session;
  - an unverified sign-in gets `EMAIL_NOT_VERIFIED` and a fresh email;
  - the user's name is HTML-escaped in the email;
  - the link verifies, signs the user in and lands on `/onboarding`;
  - a bad token ends on `/sign-in` with a readable error.

  **Not checked:** how the email looks in a real mail client, and the browser flow.

## 2026-10-07 — sign-up, sign-in and company onboarding

- **Better Auth 1.7, email/password and Google.** Google is wired, but
  **shipped unverified**: there are no OAuth credentials yet, so the button is
  hidden. Unverified Google emails are rejected in `mapProfileToUser`.
- **A third DB role, `notifyhub_auth`.** Sign-in looks a user up by email before
  any company is known, which RLS on `user` would block. Rejected alternatives:
  - leaving `user` without RLS: the directory would rely on every query
    remembering a `where company_id`;
  - giving Better Auth the owner URL: the web process would hold a key that
    bypasses everything;
  - `BYPASSRLS`: managed Postgres often refuses to grant it.

  Instead: a role-specific `auth_unscoped` policy, plus grants limited to auth
  tables and `companies`. `notifyhub_app` lost its grants on
  `session`/`account`/`verification` (tested).
- **Onboarding is one transaction on `authDb`:** insert the company, then attach
  the user only if they have no company yet. A duplicate domain or a second
  attempt rolls back with no stray company (tested). The domain comes from the
  email, and common free-mail domains are refused.
- **Server actions, not the client SDK.** Errors come back as `?error=` on the
  same page. Less JS; trade-off: no inline validation without a reload.
- **Verified against `next start` with curl:**
  - sign-up creates a session (7-day sliding expiry);
  - `/` sends an unonboarded user to `/onboarding`;
  - once a company is attached, `/` renders its name through the RLS role;
  - sign-out deletes the server-side session;
  - a wrong password is rejected;
  - a client-supplied `companyId` gets `FIELD_NOT_ALLOWED`;
  - a mismatched origin gets `INVALID_ORIGIN`.

  **Not driven through the browser:** the onboarding form's server action itself
  (its logic is covered by `onboarding.test.ts`) and the visual layout.
  Update, same day: the user checked the sign-in page in a browser and it works.
  The onboarding form still hasn't been confirmed in a browser.
- **Known hole, deliberately left for now:** no email verification, so the first
  person to sign up with a domain claims that company. It's blocked on email
  sending (SES). Listed in DEPLOYMENT known gaps.

## 2026-10-07 — repo setup and tenant isolation

- **Stack:** Next.js 16 + Postgres + Drizzle + pg-boss worker, all TypeScript.
  We considered Rust and rejected it for this product. The load is I/O-bound
  (Postgres, SES, Slack rate limits), so Rust's speed buys nothing. Its SAML and
  2FA libraries are thin, and learning the language while building an
  enterprise SaaS is slow and risky. The worker is already a separate process,
  so it could be rewritten later if it is ever measured as the bottleneck.
- **One package, not a monorepo.** Web and worker share the schema. Split when a
  second deployable needs different dependencies.
- **Tenant isolation is enforced in Postgres (RLS)**, behind app-level checks.
  Found during setup: after `set_config(..., true)` ends, the setting reads back
  as `''`, not NULL, so `::uuid` threw on unscoped queries. Fixed with
  `nullif` (migration 0002). Verified by `src/db/rls.test.ts`: an unscoped read
  returns 0 rows, a scoped read sees only its tenant, and a cross-tenant insert
  is rejected.
- **Worker verified locally:** starts and logs `tick` every minute (pg-boss
  cron). It does nothing else yet.
- **Not yet in the schema:** users, auth, reminders. Users come with Better
  Auth, which owns its own user/session tables. Building a users table first
  would have meant redoing it.
- **Shipped unverified:** nothing is deployed. `DEPLOYMENT.md` lists the gaps.
