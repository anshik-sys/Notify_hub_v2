import assert from "node:assert/strict";
import { test } from "node:test";
import { digestMessage, listChannels, lookupByEmail, reminderMessage, SlackError, SlackRateLimited, slackApi } from "./slack";

// A fake fetch: records requests, replies with the next canned response.
function fakeFetch(...replies: { status?: number; json?: object; headers?: Record<string, string> }[]) {
  const calls: { url: string; auth: string | null; body: URLSearchParams }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? null, body: init.body as URLSearchParams });
    const r = replies.shift()!;
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { f, calls };
}

test("slackApi: form body, bearer token, errors", async () => {
  const { f, calls } = fakeFetch({ json: { ok: true, ts: "1.2" } }, { json: { ok: false, error: "channel_not_found" } }, {
    status: 429,
    headers: { "retry-after": "7" },
  });
  await slackApi("chat.postMessage", "xoxb-1", { channel: "C1", blocks: [{ type: "x" }] }, f);
  assert.equal(calls[0].auth, "Bearer xoxb-1");
  assert.equal(calls[0].body.get("blocks"), '[{"type":"x"}]');
  await assert.rejects(slackApi("chat.postMessage", "t", {}, f), (e) => e instanceof SlackError && e.code === "channel_not_found");
  await assert.rejects(slackApi("chat.postMessage", "t", {}, f), (e) => e instanceof SlackRateLimited && e.retryAfter === 7);
});

test("lookupByEmail: not found is null, other errors throw", async () => {
  const { f } = fakeFetch({ json: { ok: false, error: "users_not_found" } }, { json: { ok: false, error: "invalid_auth" } });
  assert.equal(await lookupByEmail("t", "x@y.test", f), null);
  await assert.rejects(lookupByEmail("t", "x@y.test", f), SlackError);
});

test("listChannels pages and sorts", async () => {
  const { f, calls } = fakeFetch(
    { json: { ok: true, channels: [{ id: "C2", name: "random" }], response_metadata: { next_cursor: "n1" } } },
    { json: { ok: true, channels: [{ id: "C1", name: "general" }], response_metadata: { next_cursor: "" } } },
  );
  assert.deepEqual(await listChannels("t", f), [
    { id: "C1", name: "general" },
    { id: "C2", name: "random" },
  ]);
  assert.equal(calls[1].body.get("cursor"), "n1");
});

test("reminderMessage escapes and includes task fields", () => {
  const m = reminderMessage({
    title: "Pay <invoices> & co",
    description: "Use <!channel> carefully",
    links: [{ label: "Doc > v2", url: "https://x.test/a" }],
    appUrl: "https://app.test/reminders/1",
    due: "8 Oct 2026, 10:00",
  });
  const json = JSON.stringify(m.blocks);
  assert.ok(json.includes("Use &lt;!channel&gt; carefully")); // no accidental @channel
  assert.ok(json.includes("<https://x.test/a|Doc &gt; v2>"));
  assert.ok(json.includes("*Due* 8 Oct 2026, 10:00"));
  assert.equal(m.text, "Task: Pay <invoices> & co (due 8 Oct 2026, 10:00)");
});

test("task buttons: DM gets done + snoozes, channel gets done only; value is the occurrence", () => {
  const actions = (dm: boolean) =>
    (reminderMessage({ title: "T", description: "", links: [], appUrl: "u", due: "d", task: { occurrenceId: "occ-1", dm } }).blocks.find(
      (b) => (b as { type: string }).type === "actions",
    ) as { elements: { action_id: string; value?: string }[] }).elements;
  assert.deepEqual(actions(true).map((e) => e.action_id), ["task_done", "snooze_1h", "snooze_tomorrow", "open"]);
  assert.deepEqual(actions(false).map((e) => e.action_id), ["task_done", "open"]);
  assert.ok(actions(true).filter((e) => e.action_id !== "open").every((e) => e.value === "occ-1"));
});

test("digestMessage: empty, escaped, capped at 20 lines", () => {
  const empty = JSON.stringify(digestMessage({ date: "1 Jan", overdue: [], upcoming: [], appUrl: "https://a.test" }).blocks);
  assert.ok(empty.includes("Nothing overdue and nothing due"));
  const many = Array.from({ length: 23 }, (_, i) => ({ id: `r${i}`, title: `T<${i}>`, detail: "d" }));
  const m = digestMessage({ date: "1 Jan", overdue: many, upcoming: [], appUrl: "https://a.test" });
  const json = JSON.stringify(m.blocks);
  assert.ok(json.includes("Overdue tasks (23)"));
  assert.ok(json.includes("<https://a.test/reminders/r0|T&lt;0&gt;>"));
  assert.ok(json.includes("+3 more in NotifyHub"));
  assert.ok(!json.includes("r20|"));
  assert.equal(m.text, "Daily digest: 23 overdue, 0 in the next 24 hours");
});
