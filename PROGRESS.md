# Progress

Daily log, newest first. Committed, not gitignored, so worktrees merge it.

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
