# Deployment

Not deployed yet. This records what production will need.

## Processes

| Process | Command | Notes |
|---|---|---|
| web | `pnpm build && pnpm start` | Stateless; scale horizontally. |
| worker | `pnpm worker` (uses `tsx`; swap for a compiled build before prod) | Long-running. Must not run on serverless. Several replicas are safe (SKIP LOCKED plus the delivery claim). 10 parallel sends per process. |

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

| `ENCRYPTION_KEY` | web and worker (`src/lib/crypto.ts`) | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts Slack tokens. **Changing it makes stored tokens unreadable**: companies must reconnect Slack. Processes refuse to start without it. |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | web (`/api/slack/oauth`) | From the Slack app's Basic Information page. |
| `SLACK_SIGNING_SECRET` | web (interactions, phase B) | From Basic Information. |
| `SLACK_API_URL`, `SLACK_AUTHORIZE_URL` | web, worker | **Dev only** (point at `pnpm fake-slack`). Leave unset in production. |

`next build` imports the auth module, so the build environment needs the DB URLs set too (they need not be reachable).

## Migrations

`pnpm db:migrate`, run as the owner, before starting the new web and worker
versions. Migrations create roles `notifyhub_app` and `notifyhub_auth` without
passwords; set them out of band: `ALTER ROLE notifyhub_app PASSWORD '...'` (same for `notifyhub_auth`).

Migrations 0011–0013 (Slack):
- 0011 moves task completion from `deliveries` to `task_assignments`
  (backfilled);
- 0012 renames `deliveries.email` → `address`;
- 0013 adds `deliveries.channel`, the Slack message refs,
  `reminders.channels`, `reminder_targets.label` and the `slack_channel`
  kind, plus `slack_installations`.

Migration 0010 adds tasks:
- `reminders.is_task`, `due_after_minutes`;
- `reminder_occurrences.due_at`;
- `deliveries.done_at`, `followups`, `last_followup_on`;
- `companies.follow_up_time` (default 09:00).

Follow-ups run on the worker's minute tick.

Migration 0009 adds repeats:
- `reminders.recurrence`, `time_zone`, `anchor_local`, and status `paused`;
- the `reminder_occurrences` table;
- `deliveries.occurrence_id`, and the delivery unique key changes from
  `(reminder_id, email)` to `(occurrence_id, email)`.

It's hand-edited to backfill existing rows before setting NOT NULL:
- time zone from the company;
- the anchor from `send_at`;
- one occurrence per already-sent reminder.

Migration 0008 adds `deliveries`. **The worker must be running or nothing is
sent.** It needs `OWNER_DATABASE_URL`, `SMTP_URL`, `MAIL_FROM` and
`BETTER_AUTH_URL` (for the "Open in NotifyHub" link), and still `DATABASE_URL`
and `AUTH_DATABASE_URL` for now, because shared modules check they're set.
`OWNER_DATABASE_URL` must be a **direct session connection**:
`LISTEN reminders_due` and pg-boss's listener don't work through a
transaction-mode pooler (PgBouncer). Without them, sends still happen, but
only on the minute tick.

Migration 0007 adds `reminders` and `reminder_targets` (tenant RLS).

Migration 0006 adds `invitations.department_ids` and lets `notifyhub_auth`
read departments and insert memberships (invite acceptance).

Migration 0005 adds `invitations` and `user.deactivated_at`. Invite links are
built from `BETTER_AUTH_URL`, so it must be the public origin.

Migration 0004 seeds the two system roles (Company Admin, Member) with fixed
ids, and makes the earliest user of each existing company its Company Admin.

## Outside the repo

- **Slack app** (api.slack.com/apps → Create New App → From scratch), one for
  NotifyHub, used by every customer company:
  1. OAuth & Permissions → Redirect URLs: `https://<host>/api/slack/oauth`.
  2. Bot Token Scopes: `chat:write`, `chat:write.public`, `channels:read`,
     `users:read`, `users:read.email`, `im:write`.
  3. Interactivity & Shortcuts → On, Request URL
     `https://<host>/api/slack/interactions` (phase B).
  4. Basic Information → copy the Client ID, Client Secret and Signing Secret
     into the env.
  5. Manage Distribution → activate public distribution, so other companies'
     workspaces can install it.
  6. **Local testing against real Slack:** run `ngrok http 3000`, use the
     https URL as `BETTER_AUTH_URL` and in steps 1 and 3, and unset
     `SLACK_API_URL` / `SLACK_AUTHORIZE_URL`.

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
- Slack has only been tested against the fake (`scripts/fake-slack.ts`). A real workspace test waits on a real Slack app (steps above).
- Slack: private channels aren't offered (they'd need the bot invited and `groups:read`); channel scope isn't member-based.
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
- [ ] "Now" to two people: both emails arrive within seconds, each addressed only to that person, Reply-To the creator; the reminder shows "2 sent".
- [ ] Stop the worker, create a "Now" reminder: after a minute it shows "Delayed" with the warning; start the worker: it's sent once and the warning is gone.
- [ ] A daily "Now" reminder sends once, then shows "Next: tomorrow …"; Pause shows "Paused" (never "Delayed"); Skip moves Next by one; Resume never lands on a skipped one.
- [ ] A task for two people: both get "Task: …"; one marks done → "1 of 2 done"; at the company follow-up time the other gets one "Overdue: …" (only one that day).
- [ ] Integrations → Add to Slack → back on the page, "Connected to <workspace>"; set a fallback channel.
- [ ] A reminder on Email + Slack to a department plus a channel: emails arrive, each member gets a DM, the channel gets one post; someone without Slack shows up in the fallback channel.
- [ ] Reject needs a reason and emails the creator; approve moves it to Scheduled.
- [ ] Make someone manager of one department → they can add/remove members there, and the other departments show no member controls.
- [ ] Deactivate that person → their open tab is bounced to sign-in, and signing in says "deactivated".
- [ ] Signing in before verifying shows "Verify your email first" and sends a new link.
- [ ] Google sign-in round-trips (only if configured).
- [ ] `pnpm test` passes against the production-shaped roles (staging).
