import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { reminderOccurrences, reminders, slackInstallations, taskAssignments, user } from "@/db/schema";
import { authDb } from "./auth";
import { decrypt } from "./crypto";
import { respond, updateMessage, usersInfo, withStatus } from "./slack";
import { formatInZone, toLocalInput, zonedToUtc } from "./time";

// A Mark done / Snooze click. The button's value is the occurrence; the person
// is whoever clicked, mapped Slack user -> email -> NotifyHub user, and they
// must be an assignee of that occurrence. So nobody acts for someone else, and
// the same buttons work in DMs and shared channel posts.
export type Click = {
  teamId: string;
  slackUserId: string;
  actionId: "task_done" | "snooze_1h" | "snooze_tomorrow";
  occurrenceId: string;
  channelId: string;
  messageTs: string;
  responseUrl: string;
  blocks: { type: string; block_id?: string }[];
};

type Result = { outcome: "done" | "snoozed" | "refused" | "unknown"; after: () => Promise<void> };
const nothing = async () => {};

// The database change happens here; Slack updates are returned as `after`, for
// the route to run once it has answered Slack (3-second limit).
export async function handleTaskAction(c: Click, f?: typeof fetch, now = new Date()): Promise<Result> {
  const [inst] = await authDb
    .select({ companyId: slackInstallations.companyId, tokenEnc: slackInstallations.botTokenEnc })
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, c.teamId));
  if (!inst) return { outcome: "unknown", after: nothing };
  const token = decrypt(inst.tokenEnc);
  const ephemeral = (text: string) => () => respond(c.responseUrl, { response_type: "ephemeral", replace_original: false, text }, f);
  const refused = (text: string): Result => ({ outcome: "refused", after: ephemeral(text) });

  const email = await usersInfo(token, c.slackUserId, f).catch(() => null);
  if (!email) return refused("NotifyHub couldn't match your Slack account to a person (no email on your Slack profile).");

  const found = await withTenant(inst.companyId, async (tx) => {
    const [row] = await tx
      .select({ a: taskAssignments, title: reminders.title, reminderId: reminders.id, timeZone: reminders.timeZone })
      .from(taskAssignments)
      .innerJoin(user, eq(user.id, taskAssignments.userId))
      .innerJoin(reminders, eq(reminders.id, taskAssignments.reminderId))
      .innerJoin(reminderOccurrences, eq(reminderOccurrences.id, taskAssignments.occurrenceId))
      .where(and(eq(taskAssignments.occurrenceId, c.occurrenceId), eq(sql`lower(${user.email})`, email)))
      .for("update", { of: taskAssignments });
    if (!row) return null;
    if (c.actionId === "task_done") {
      if (!row.a.doneAt) await tx.update(taskAssignments).set({ doneAt: now, snoozedUntil: null }).where(eq(taskAssignments.id, row.a.id));
      return { ...row, doneAt: row.a.doneAt ?? now, until: null };
    }
    if (row.a.doneAt) return { ...row, doneAt: row.a.doneAt, until: null };
    const until =
      c.actionId === "snooze_1h"
        ? new Date(now.getTime() + 3_600_000)
        : zonedToUtc(`${nextLocalDate(now, row.timeZone)}T09:00`, row.timeZone)!;
    await tx.update(taskAssignments).set({ snoozedUntil: until }).where(eq(taskAssignments.id, row.a.id));
    return { ...row, doneAt: null, until };
  });
  if (!found) return refused("This task isn't assigned to you.");

  const appUrl = `${process.env.BETTER_AUTH_URL}/reminders/${found.reminderId}`;
  const isDm = c.channelId.startsWith("D");
  // In a DM the message is the person's own: replace the buttons with a status.
  // A channel post is shared: tell only the clicker.
  const status = (text: string) => async () =>
    isDm ? void (await updateMessage(token, c.channelId, c.messageTs, found.title, withStatus(c.blocks, text, appUrl), f)) : ephemeral(text)();

  if (c.actionId === "task_done" || found.doneAt)
    return { outcome: "done", after: status(`✅ Done ${formatInZone(found.doneAt!, found.timeZone)}`) };
  return {
    outcome: "snoozed",
    after: status(`⏰ Snoozed until ${formatInZone(found.until!, found.timeZone)}. You'll get this again then.`),
  };
}

// Tomorrow's date in tz, as YYYY-MM-DD.
function nextLocalDate(now: Date, tz: string) {
  const today = toLocalInput(now, tz).slice(0, 10);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
