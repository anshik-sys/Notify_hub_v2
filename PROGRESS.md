# Progress

Daily log, newest first. Committed, not gitignored, so worktrees merge it.

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
