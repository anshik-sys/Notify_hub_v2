import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

// Connects as notifyhub_app, which is subject to row-level security.
export const db = drizzle(process.env.DATABASE_URL, { schema, casing: "snake_case" });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Every tenant query goes through here. The setting is transaction-local, so a
// pooled connection never carries one company's id into another request.
export function withTenant<T>(companyId: string, fn: (tx: Tx) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.company_id', ${companyId}, true)`);
    return fn(tx);
  });
}
