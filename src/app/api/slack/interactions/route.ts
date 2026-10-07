import { after } from "next/server";
import { type Click, handleTaskAction } from "@/lib/slack-actions";
import { verifySlackSignature } from "@/lib/slack-signature";

const TASK_ACTIONS = new Set(["task_done", "snooze_1h", "snooze_tomorrow"]);

// Slack Interactivity Request URL. The signature check comes first, on the raw
// body: without it anyone could POST a fake click. Valid but irrelevant
// payloads get 200 (Slack shows an error to the user on anything else).
export async function POST(req: Request) {
  const raw = await req.text();
  const ok = verifySlackSignature(
    raw,
    req.headers.get("x-slack-request-timestamp"),
    req.headers.get("x-slack-signature"),
    process.env.SLACK_SIGNING_SECRET ?? "",
  );
  if (!ok) return new Response("invalid signature", { status: 401 });

  const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}");
  const action = payload.actions?.[0];
  if (payload.type !== "block_actions" || !TASK_ACTIONS.has(action?.action_id)) return new Response(null, { status: 200 });

  const click: Click = {
    teamId: payload.team?.id ?? "",
    slackUserId: payload.user?.id ?? "",
    actionId: action.action_id,
    occurrenceId: String(action.value ?? ""),
    channelId: payload.container?.channel_id ?? payload.channel?.id ?? "",
    messageTs: payload.container?.message_ts ?? payload.message?.ts ?? "",
    responseUrl: payload.response_url ?? "",
    blocks: payload.message?.blocks ?? [],
  };
  if (!/^[0-9a-f-]{36}$/i.test(click.occurrenceId)) return new Response(null, { status: 200 });
  const result = await handleTaskAction(click);
  after(() => result.after().catch((e) => console.error("Slack update after click failed", e)));
  return new Response(null, { status: 200 });
}
