// Every Slack Web API call goes through slackApi. SLACK_API_URL and
// SLACK_AUTHORIZE_URL default to Slack; in dev and tests they point at the
// fake (scripts/fake-slack.ts). Never log tokens.

export const SLACK_SCOPES = ["chat:write", "chat:write.public", "channels:read", "users:read", "users:read.email", "im:write"];
const apiBase = () => process.env.SLACK_API_URL ?? "https://slack.com/api";
export const authorizeUrl = () => process.env.SLACK_AUTHORIZE_URL ?? "https://slack.com/oauth/v2/authorize";

export class SlackError extends Error {
  constructor(public code: string) {
    super(`Slack: ${code}`);
  }
}
export class SlackRateLimited extends Error {
  constructor(public retryAfter: number) {
    super(`Slack rate limited, retry after ${retryAfter}s`);
  }
}

// Form-encoded for every method (Slack accepts it everywhere; JSON bodies it
// doesn't). Object values (blocks) are sent as JSON strings.
export async function slackApi<T = Record<string, unknown>>(
  method: string,
  token: string | null,
  args: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(args))
    if (v !== undefined && v !== null) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetchImpl(`${apiBase()}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  if (res.status === 429) throw new SlackRateLimited(Number(res.headers.get("retry-after") ?? 1));
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!json.ok) throw new SlackError(json.error ?? "unknown_error");
  return json;
}

// --- The methods we use ------------------------------------------------------------

type Fetch = typeof fetch;

export async function oauthAccess(code: string, redirectUri: string, f?: Fetch) {
  const r = await slackApi<{ access_token: string; bot_user_id: string; team: { id: string; name: string } }>(
    "oauth.v2.access",
    null,
    { client_id: process.env.SLACK_CLIENT_ID, client_secret: process.env.SLACK_CLIENT_SECRET, code, redirect_uri: redirectUri },
    f,
  );
  return { token: r.access_token, botUserId: r.bot_user_id, teamId: r.team.id, teamName: r.team.name };
}

export const revoke = (token: string, f?: Fetch) => slackApi("auth.revoke", token, {}, f);

// Public channels, name-sorted (paged; ponytail: capped at 1000, enough for the picker).
export async function listChannels(token: string, f?: Fetch) {
  const out: { id: string; name: string }[] = [];
  let cursor: string | undefined;
  do {
    const r = await slackApi<{ channels: { id: string; name: string }[]; response_metadata?: { next_cursor?: string } }>(
      "conversations.list",
      token,
      { types: "public_channel", exclude_archived: "true", limit: "200", cursor },
      f,
    );
    out.push(...r.channels.map(({ id, name }) => ({ id, name })));
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor && out.length < 1000);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// null when that email has no Slack account in this workspace.
export async function lookupByEmail(token: string, email: string, f?: Fetch) {
  try {
    return (await slackApi<{ user: { id: string } }>("users.lookupByEmail", token, { email }, f)).user.id;
  } catch (e) {
    if (e instanceof SlackError && e.code === "users_not_found") return null;
    throw e;
  }
}

export async function openDm(token: string, slackUserId: string, f?: Fetch) {
  return (await slackApi<{ channel: { id: string } }>("conversations.open", token, { users: slackUserId }, f)).channel.id;
}

export async function postMessage(token: string, channel: string, text: string, blocks: unknown[], f?: Fetch) {
  const r = await slackApi<{ ts: string; channel: string }>("chat.postMessage", token, { channel, text, blocks }, f);
  return { ts: r.ts, channel: r.channel };
}

// The email on a Slack user's profile (needs users:read.email); null if hidden/unknown.
export async function usersInfo(token: string, slackUserId: string, f?: Fetch) {
  const r = await slackApi<{ user: { profile?: { email?: string } } }>("users.info", token, { user: slackUserId }, f);
  return r.user.profile?.email?.toLowerCase() ?? null;
}

// Reply through an interaction's response_url (e.g. an ephemeral message only
// the clicker sees). Not a Web API method: plain JSON, no token.
export async function respond(responseUrl: string, body: object, f: Fetch = fetch) {
  await f(responseUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export const updateMessage = (token: string, channel: string, ts: string, text: string, blocks: unknown[], f?: Fetch) =>
  slackApi("chat.update", token, { channel, ts, text, blocks }, f);

// --- Message content -----------------------------------------------------------------

// Slack mrkdwn: only &, < and > need escaping (they'd start links/mentions).
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function reminderMessage(m: {
  title: string;
  description: string;
  links: { label: string; url: string }[];
  appUrl: string;
  due?: string; // tasks: formatted due time
  note?: string; // e.g. fallback-channel explanation
  // Task buttons. value = occurrence id: the clicker must be an assignee of it.
  // Snooze only in a DM (it's personal).
  task?: { occurrenceId: string; dm: boolean };
  prefix?: string; // "Overdue" / "Snoozed reminder" lines for follow-ups
}) {
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: (m.due ? `Task: ${m.title}` : m.title).slice(0, 150) } },
  ];
  if (m.prefix) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${esc(m.prefix)}*` } });
  if (m.note) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: esc(m.note) }] });
  if (m.description) blocks.push({ type: "section", text: { type: "mrkdwn", text: esc(m.description).slice(0, 3000) } });
  if (m.due) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Due* ${esc(m.due)}` } });
  if (m.links.length)
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: m.links.map((l) => `• <${l.url}|${esc(l.label)}>`).join("\n") },
    });
  blocks.push({ type: "actions", block_id: "task", elements: [...taskButtons(m.task), openButton(m.appUrl)] });
  const text = m.due ? `Task: ${m.title} (due ${m.due})` : m.title; // notification/fallback text
  return { text, blocks };
}

const button = (text: string, action_id: string, value: string, style?: "primary") => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id,
  value,
  ...(style ? { style } : {}),
});
const openButton = (url: string) => ({ type: "button", text: { type: "plain_text", text: "Open in NotifyHub" }, url, action_id: "open" });

function taskButtons(task?: { occurrenceId: string; dm: boolean }) {
  if (!task) return [];
  return [
    button("Mark done", "task_done", task.occurrenceId, "primary"),
    ...(task.dm
      ? [button("Snooze 1 hour", "snooze_1h", task.occurrenceId), button("Snooze until tomorrow", "snooze_tomorrow", task.occurrenceId)]
      : []),
  ];
}

// After a click in a DM: keep the message, swap the buttons for a status line.
export function withStatus(blocks: { type: string; block_id?: string }[], status: string, appUrl: string) {
  return [
    ...blocks.filter((b) => b.block_id !== "task" && b.block_id !== "status"),
    { type: "context", block_id: "status", elements: [{ type: "mrkdwn", text: esc(status) }] },
    { type: "actions", block_id: "task", elements: [openButton(appUrl)] },
  ];
}
