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

| `SMTP_URL` | web, at import of `src/lib/mail.ts` | Prod: `smtps://<SES SMTP user>:<SES SMTP password>@email-smtp.<region>.amazonaws.com:465`. URL-encode the password. Dev: `smtp://localhost:1025` (Mailpit). |
| `MAIL_FROM` | web (`src/lib/mail.ts`) | `NotifyHub <notifications@notifyhub.app>`. The domain must be verified in SES. |

`next build` imports the auth module, so the build environment needs the DB URLs set too (they need not be reachable).

## Migrations

`pnpm db:migrate`, run as the owner, before starting the new web and worker
versions. Migrations create roles `notifyhub_app` and `notifyhub_auth` without
passwords; set them out of band: `ALTER ROLE notifyhub_app PASSWORD '...'` (same for `notifyhub_auth`).

Migration 0007 adds `reminders` and `reminder_targets` (tenant RLS). Nothing
sends yet: delivery comes with 0008 and the worker.

Migration 0006 adds `invitations.department_ids` and lets `notifyhub_auth`
read departments and insert memberships (invite acceptance).

Migration 0005 adds `invitations` and `user.deactivated_at`. Invite links are
built from `BETTER_AUTH_URL`, so it must be the public origin.

Migration 0004 seeds the two system roles (Company Admin, Member) with fixed
ids, and makes the earliest user of each existing company its Company Admin.

## Outside the repo

- **AWS SES** (in the region used by `SMTP_URL`):
  - verify the `notifyhub.app` domain identity, and publish its DKIM CNAMEs, SPF and DMARC records in DNS;
  - create SMTP credentials (IAM). These are not the IAM access key itself;
  - request production access. In the sandbox, SES only delivers to verified addresses.
- **Google OAuth client** (Google Cloud console → Credentials): authorised
  redirect URI `https://<host>/api/auth/callback/google`, authorised JavaScript
  origin `https://<host>`. One per environment.

## Known gaps

- No health-check endpoint yet (PRD 11.2).
- The worker runs via `tsx`, with no compiled build.
- No env validation beyond "is it set". The PRD's "refuse to start with insecure
  config" is not implemented.
- No deploy target chosen.
- No password reset yet. Email sending now exists, so it's unblocked.
- No bounce or complaint handling (SES → SNS). Bounced addresses aren't suppressed (PRD 7.1).
- A failed verification email is only logged. The user gets a new link by signing in again.
- Rate limiting is Better Auth's built-in in-memory limiter: per instance,
  reset on restart. The PRD wants a shared store that fails closed.
- Google sign-in can't be used to accept an invite (password only).
- Reminder form errors redirect back with the message, and **what was typed is lost** (no client JS). Native `required` catches the common case.
- Tests need Mailpit running: `createInvitation` sends real mail.

## Verification checklist

- [ ] `DATABASE_URL` user is not a superuser: `select rolsuper, rolbypassrls from pg_roles where rolname = current_user` is `f, f`.
- [ ] Worker logs `tick` once a minute.
- [ ] Sign up → verification email arrives (check spam and the `From`) → link lands on onboarding → home shows the company name; sign out returns to `/sign-in`.
- [ ] Invite someone → email arrives → accept link creates the account and lands on the company → the same link again says "already used".
- [ ] As a member, a reminder to your own department is "Scheduled", and one to another department is "Needs approval"; admins get an email.
- [ ] Reject needs a reason and emails the creator; approve moves it to Scheduled.
- [ ] Make someone manager of one department → they can add/remove members there, and the other departments show no member controls.
- [ ] Deactivate that person → their open tab is bounced to sign-in, and signing in says "deactivated".
- [ ] Signing in before verifying shows "Verify your email first" and sends a new link.
- [ ] Google sign-in round-trips (only if configured).
- [ ] `pnpm test` passes against the production-shaped roles (staging).
