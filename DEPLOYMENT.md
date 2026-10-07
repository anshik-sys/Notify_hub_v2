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

## Migrations

`pnpm db:migrate`, run as the owner, before starting the new web and worker
versions. The first run creates role `notifyhub_app` without a password; set one
out of band: `ALTER ROLE notifyhub_app PASSWORD '...'`.

## Known gaps

- No health-check endpoint yet (PRD 11.2).
- The worker runs via `tsx`, with no compiled build.
- No env validation beyond "is it set". The PRD's "refuse to start with insecure
  config" is not implemented.
- No deploy target chosen.

## Verification checklist

- [ ] `DATABASE_URL` user is not a superuser: `select rolsuper, rolbypassrls from pg_roles where rolname = current_user` is `f, f`.
- [ ] Worker logs `tick` once a minute.
- [ ] `pnpm test` passes against the production-shaped roles (staging).
