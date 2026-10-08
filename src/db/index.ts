import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { headers } from "next/headers";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

// Connects as notifyhub_app, which is subject to row-level security.
export const db = drizzle(process.env.DATABASE_URL, { schema, casing: "snake_case" });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Who's acting, for the audit log (PRD 9.1). requireMember() records the
// signed-in person against this request's headers object (Next returns the
// same one throughout a request: pages, server actions, route handlers).
// React cache() would not do: it isn't request-scoped in server actions.
// Outside a request (worker, tests) headers() throws: no actor, nothing logged.
const actors = new WeakMap<object, string>();
async function requestHeaders() {
  try {
    return await headers();
  } catch {
    return null;
  }
}
export async function setCurrentActor(id: string) {
  const h = await requestHeaders();
  if (h) actors.set(h, id);
}

// Every tenant query goes through here. The settings are transaction-local, so
// a pooled connection never carries one company's id (or actor) into another
// request. actorId overrides the request's actor (Slack buttons, tests).
export async function withTenant<T>(companyId: string, fn: (tx: Tx) => Promise<T>, actorId?: string) {
  const h = actorId === undefined ? await requestHeaders() : null;
  const actor = actorId ?? (h && actors.get(h)) ?? "";
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.company_id', ${companyId}, true), set_config('app.actor_id', ${actor}, true)`);
    return fn(tx);
  });
}
