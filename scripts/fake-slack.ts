// DEV/TEST ONLY: a stand-in for Slack, so the whole integration runs without a
// real workspace. Never deployed. Point SLACK_API_URL / SLACK_AUTHORIZE_URL here.
//
//   pnpm fake-slack                       # http://localhost:4999
//   GET  /_messages                       # everything posted/updated, newest last
//   DELETE /_messages                     # reset
//
// Directory: every email has a Slack user, except local parts starting with
// "noslack" (to exercise the fallback channel). Bot token: xoxb-fake.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_SLACK_PORT ?? 4999);
const TOKEN = "xoxb-fake";
const TEAM = { id: process.env.FAKE_SLACK_TEAM ?? "T0FAKE", name: "Fake Workspace" };
const CHANNELS = [
  { id: "C0GENERAL", name: "general" },
  { id: "C0RANDOM", name: "random" },
  { id: "C0OPS", name: "ops" },
];
type Msg = { kind: "post" | "update"; channel: string; ts: string; text: string; blocks: unknown };
const messages: Msg[] = [];
let tsCounter = 1000;
const users = new Map<string, string>(); // slack id -> email

const slackId = (email: string) => "U" + createHash("sha1").update(email.toLowerCase()).digest("hex").slice(0, 8).toUpperCase();

function api(method: string, p: URLSearchParams, auth: string | undefined) {
  if (method === "oauth.v2.access")
    return p.get("code") === "fake-code"
      ? { ok: true, access_token: TOKEN, bot_user_id: "UBOT", team: TEAM }
      : { ok: false, error: "invalid_code" };
  if (auth !== `Bearer ${TOKEN}`) return { ok: false, error: "invalid_auth" };
  switch (method) {
    case "auth.revoke":
      return { ok: true, revoked: true };
    case "conversations.list":
      return { ok: true, channels: CHANNELS, response_metadata: { next_cursor: "" } };
    case "users.lookupByEmail": {
      const email = p.get("email") ?? "";
      if (email.startsWith("noslack")) return { ok: false, error: "users_not_found" };
      users.set(slackId(email), email);
      return { ok: true, user: { id: slackId(email) } };
    }
    case "users.info": {
      const email = users.get(p.get("user") ?? "");
      return email ? { ok: true, user: { id: p.get("user"), profile: { email } } } : { ok: false, error: "user_not_found" };
    }
    case "conversations.open":
      return { ok: true, channel: { id: "D" + (p.get("users") ?? "").slice(1) } };
    case "chat.postMessage":
    case "chat.update": {
      const channel = p.get("channel") ?? "";
      const known = channel.startsWith("D") || CHANNELS.some((c) => c.id === channel);
      if (!known) return { ok: false, error: "channel_not_found" };
      const ts = method === "chat.update" ? (p.get("ts") ?? "") : `${tsCounter++}.000100`;
      messages.push({
        kind: method === "chat.update" ? "update" : "post",
        channel,
        ts,
        text: p.get("text") ?? "",
        blocks: JSON.parse(p.get("blocks") ?? "[]"),
      });
      return { ok: true, channel, ts };
    }
    default:
      return { ok: false, error: "unknown_method" };
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/oauth/v2/authorize") {
    // Auto-approve: straight back to the app with a code.
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", "fake-code");
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (url.pathname === "/_messages") {
    if (req.method === "DELETE") messages.length = 0;
    return send(200, messages);
  }
  if (url.pathname.startsWith("/api/") && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return send(200, api(url.pathname.slice(5), new URLSearchParams(raw), req.headers.authorization));
  }
  send(404, { ok: false, error: "not_found" });
}).listen(PORT, () => console.log(`fake Slack on http://localhost:${PORT}`));
