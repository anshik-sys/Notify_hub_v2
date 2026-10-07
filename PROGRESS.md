# Progress

Daily log, newest first. Committed, not gitignored, so worktrees merge it.

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
