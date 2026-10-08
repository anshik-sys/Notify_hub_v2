import { sql } from "drizzle-orm";
import { db } from "@/db";

// For load balancers and uptime checks (PRD 11.2). No auth and nothing
// sensitive: just whether the database answers and the worker ticked lately.
// 200 when both are fine, 503 otherwise.
export const dynamic = "force-dynamic";
const WORKER_STALE_SECONDS = 180;

export async function GET() {
  let db_ = false;
  let workerAge: number | null = null;
  try {
    const res = (await db.execute(sql`select extract(epoch from now() - at)::int as age from worker_heartbeat where id = 1`)) as unknown as {
      rows: { age: number }[];
    };
    db_ = true;
    workerAge = res.rows[0]?.age ?? null;
  } catch (e) {
    console.error("health: database check failed", e);
  }
  const worker = workerAge !== null && workerAge < WORKER_STALE_SECONDS;
  const ok = db_ && worker;
  return Response.json(
    { ok, db: db_, worker, workerLastTickSecondsAgo: workerAge },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
