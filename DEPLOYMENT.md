# Deployment

Not deployed yet. This records what production will need.

## Processes

| Process | Command | Notes |
|---|---|---|
| web | `pnpm build && pnpm start` | Stateless; scale horizontally. |
| worker | `pnpm worker` (uses `tsx`; swap for a compiled build before prod) | Long-running. Must not run on serverless. pg-boss makes several replicas safe. |

Both processes need a container host with a persistent process (Fly, Railway, ECS).

## Environment variables

| Var | Read by | Notes |
|---|---|---|
| `DATABASE_URL` | web, at runtime (`src/db/index.ts`) | Must be the `notifyhub_app` role. Never the owner or a superuser: that disables RLS. |
| `OWNER_DATABASE_URL` | `drizzle.config.ts` (migrations), worker | Table owner. |
| `AUTH_DATABASE_URL` | web, at import of `src/lib/auth.ts` (build and runtime) | Role `notifyhub_auth`. |
| `BETTER_AUTH_SECRET` | web (Better Auth) | Signs cookies. 32+ random bytes: `openssl rand -hex 32`. Rotating it signs everyone out. |
| `BETTER_AUTH_URL` | web (Better Auth) | Public origin, e.g. `https://app.notifyhub.app`. Requests from any other origin get `INVALID_ORIGIN`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | web (Better Auth) | Optional. Google sign-in is hidden unless both are set. |

`next build` imports the auth module, so the build environment needs the DB URLs set too (they need not be reachable).

## Migrations

`pnpm db:migrate`, run as the owner, before starting the new web and worker
versions. Migrations create roles `notifyhub_app` and `notifyhub_auth` without
passwords; set them out of band: `ALTER ROLE notifyhub_app PASSWORD '...'` (same for `notifyhub_auth`).

## Outside the repo

- **Google OAuth client** (Google Cloud console → Credentials): authorised
  redirect URI `https://<host>/api/auth/callback/google`, authorised JavaScript
  origin `https://<host>`. One per environment.

## Known gaps

- No health-check endpoint yet (PRD 11.2).
- The worker runs via `tsx`, with no compiled build.
- No env validation beyond "is it set". The PRD's "refuse to start with insecure
  config" is not implemented.
- No deploy target chosen.
- **No email verification.** Anyone can sign up with `x@acme.com` and claim the
  acme.com company by onboarding first. It must be required before onboarding
  once email sending (SES) exists.
- No password reset. It needs email sending.
- Rate limiting is Better Auth's built-in in-memory limiter: per instance,
  reset on restart. The PRD wants a shared store that fails closed.
- No roles yet. The user who onboards a company isn't marked admin anywhere.
  When RBAC lands, backfill the earliest user per company as admin.

## Verification checklist

- [ ] `DATABASE_URL` user is not a superuser: `select rolsuper, rolbypassrls from pg_roles where rolname = current_user` is `f, f`.
- [ ] Worker logs `tick` once a minute.
- [ ] Sign up → onboarding → home shows the company name; sign out returns to `/sign-in`.
- [ ] Google sign-in round-trips (only if configured).
- [ ] `pnpm test` passes against the production-shaped roles (staging).
