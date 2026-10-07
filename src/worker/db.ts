import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";

// The worker's connection: the table owner, which bypasses RLS because the
// scheduler works across all companies. Every query here must filter by
// company itself. Never import src/worker from the web app.
export const ownerUrl = process.env.OWNER_DATABASE_URL!;
if (!ownerUrl) throw new Error("OWNER_DATABASE_URL is not set");
export const ownerDb = drizzle(ownerUrl, { schema, casing: "snake_case" });
