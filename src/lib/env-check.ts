// Production refuses to start with missing or insecure settings (PRD 11.2).
// problems() is pure; checkEnvironment() adds the database facts and decides
// whether to stop. Local runs (BETTER_AUTH_URL on localhost) may use http and
// the fake Slack.

type Env = Record<string, string | undefined>;
export type DbFacts = { superuser: boolean; bypassRls: boolean } | null;

const isLocal = (url: string) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

export function problems(env: Env, db: DbFacts): string[] {
  const out: string[] = [];
  const url = env.BETTER_AUTH_URL ?? "";
  const local = isLocal(url);
  if ((env.BETTER_AUTH_SECRET ?? "").length < 32) out.push("BETTER_AUTH_SECRET must be at least 32 characters (openssl rand -base64 32).");
  if (!url) out.push("BETTER_AUTH_URL is not set.");
  else if (!local && !url.startsWith("https://")) out.push("BETTER_AUTH_URL must be https:// outside localhost.");
  if (Buffer.from(env.ENCRYPTION_KEY ?? "", "base64").length !== 32) out.push("ENCRYPTION_KEY must be 32 bytes, base64.");
  for (const k of ["DATABASE_URL", "AUTH_DATABASE_URL", "OWNER_DATABASE_URL", "SMTP_URL", "MAIL_FROM"]) if (!env[k]) out.push(`${k} is not set.`);
  if (db?.superuser || db?.bypassRls)
    out.push("DATABASE_URL connects as a superuser or a BYPASSRLS role: tenant isolation would be off. Use notifyhub_app.");
  if (env.SLACK_CLIENT_ID) {
    if (!env.SLACK_CLIENT_SECRET) out.push("SLACK_CLIENT_SECRET is not set (Slack is configured).");
    if (!env.SLACK_SIGNING_SECRET) out.push("SLACK_SIGNING_SECRET is not set (Slack is configured).");
    if (!local && (env.SLACK_API_URL || env.SLACK_AUTHORIZE_URL)) out.push("SLACK_API_URL / SLACK_AUTHORIZE_URL point Slack elsewhere (the dev fake); unset them in production.");
  }
  if (env.GOOGLE_CLIENT_ID && !env.GOOGLE_CLIENT_SECRET) out.push("GOOGLE_CLIENT_SECRET is not set (Google sign-in is configured).");
  return out;
}

// Called at startup by the web server (src/instrumentation.ts) and the worker.
export async function checkEnvironment(who: string) {
  let facts: DbFacts = null;
  if (process.env.DATABASE_URL) {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await c.connect();
      const { rows } = await c.query("select rolsuper, rolbypassrls from pg_roles where rolname = current_user");
      facts = { superuser: rows[0].rolsuper, bypassRls: rows[0].rolbypassrls };
    } catch (e) {
      console.error(`${who}: couldn't check the database role`, e);
    } finally {
      await c.end().catch(() => {});
    }
  }
  const list = problems(process.env, facts);
  if (!list.length) return;
  const msg = `${who}: unsafe configuration:\n${list.map((p) => `  - ${p}`).join("\n")}`;
  if (process.env.NODE_ENV === "production") {
    console.error(`${msg}\nRefusing to start.`);
    process.exit(1);
  }
  console.warn(msg);
}
