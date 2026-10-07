<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Rules for this repo

- Follow `WORKING_AGREEMENT.md`. Never commit; no attribution trailers.
- Next.js 16, React 19, Tailwind 4, Drizzle 0.45, pg-boss 12. Check `node_modules` docs, not memory.
- Import alias: `@/*` -> `src/*`.
- Drizzle uses `casing: "snake_case"` in both `drizzle.config.ts` and `src/db/index.ts`. Keep them in sync.
- Every tenant table: `company_id` column, `tenantPolicy(...)`, `.enableRLS()`. Add a case to `src/db/rls.test.ts`.
- Tenant reads and writes go through `withTenant()`. The web app never uses the owner URL.
- Do not "simplify" the two DB roles, the transaction-local `set_config`, or the `nullif` in the policy. See README.
- `pnpm typecheck` runs `next typegen` first; plain `tsc` fails on `LayoutProps`.
