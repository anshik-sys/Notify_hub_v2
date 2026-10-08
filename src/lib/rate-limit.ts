import { sql } from "drizzle-orm";
import { db } from "@/db";

// Rate limits for our server actions (PRD 11.1). Better Auth's own limiter
// only guards its HTTP routes (/api/auth/*); our forms call auth.api.*
// directly, which skips it, so they're limited here.
// Fixed window in Postgres: one atomic upsert per check, shared by every app
// instance. Fails closed: if the store can't be reached, the action is refused.

type Query = (key: string, windowSeconds: number) => Promise<{ count: number; windowStart: Date }>;

const pgQuery: Query = async (key, windowSeconds) => {
  const res = (await db.execute(sql`
    insert into rate_limits (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when rate_limits.window_start <= now() - make_interval(secs => ${windowSeconds}) then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start <= now() - make_interval(secs => ${windowSeconds}) then now() else rate_limits.window_start end
    returning count, window_start`)) as unknown as { rows: { count: number; window_start: Date }[] };
  return { count: res.rows[0].count, windowStart: new Date(res.rows[0].window_start) };
};

export async function limit(key: string, max: number, windowSeconds: number, query: Query = pgQuery) {
  try {
    const { count, windowStart } = await query(key, windowSeconds);
    const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + windowSeconds * 1000 - Date.now()) / 1000));
    return count <= max ? { ok: true as const } : { ok: false as const, retryAfter };
  } catch (e) {
    console.error("rate limiter unavailable; refusing", e);
    return { ok: false as const, retryAfter: 60, unavailable: true };
  }
}

// Every rule must pass; returns the first refusal's message, or null.
export async function limits(rules: [key: string, max: number, windowSeconds: number][]) {
  for (const [key, max, windowSeconds] of rules) {
    const r = await limit(key, max, windowSeconds);
    if (!r.ok) return "unavailable" in r ? "This is briefly unavailable. Try again in a minute." : tooMany(r.retryAfter);
  }
  return null;
}

export const tooMany = (retryAfter: number) =>
  `Too many attempts. Try again in ${retryAfter < 90 ? `${retryAfter} seconds` : `${Math.ceil(retryAfter / 60)} minutes`}.`;

// The client's address as the proxy in front reports it. The header must be
// set (overwritten) by that proxy, or it can be spoofed; per-account keys
// still hold either way.
export function clientIp(h: Headers) {
  const raw = h.get(process.env.CLIENT_IP_HEADER || "x-forwarded-for") ?? "";
  return raw.split(",")[0].trim() || "unknown";
}

// The worker's tick clears windows nobody has touched for a day.
export const purgeRateLimits = () => db.execute(sql`delete from rate_limits where window_start < now() - interval '1 day'`);
