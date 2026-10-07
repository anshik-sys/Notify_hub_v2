import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { attachments, reminders } from "@/db/schema";
import { emailFiles } from "./attachments";
import { renderReminderEmail } from "./email-render";
import { sendMail } from "./mail";
import { type Access, can } from "./permissions";
import { reminderAccess } from "./reminders";
import { lookupByEmail, openDm, postMessage, reminderMessage } from "./slack";
import { getInstallation } from "./slack-installations";
import { getBlob } from "./storage";
import { formatInZone } from "./time";

// PRD 5.12: "Send now" and "Send me a test".
type Actor = { id: string; email: string; access: Access };

// Send now. One-time: its send time becomes now (the normal dispatch sends it,
// once). Repeating: one extra occurrence now (send_now_at, picked up by the
// worker's dispatchManual); the next scheduled one stays where it is.
// The creator, or anyone with reminders.send_now.
export async function sendNow(actor: Actor, companyId: string, id: string) {
  return withTenant(companyId, async (tx) => {
    const [r] = await tx.select().from(reminders).where(eq(reminders.id, id)).for("update");
    if (!r || (r.createdBy !== actor.id && !can(actor.access, "reminders.send_now"))) return { error: "Reminder not found." };
    const allowed = r.status === "scheduled" || (r.recurrence && r.status === "paused");
    if (!allowed)
      return {
        error:
          r.status === "pending_approval"
            ? "It's waiting for approval; it can be sent once approved."
            : "Only a scheduled reminder can be sent now.",
      };
    if (r.recurrence) await tx.update(reminders).set({ sendNowAt: new Date() }).where(eq(reminders.id, id));
    else await tx.update(reminders).set({ sendAt: new Date() }).where(eq(reminders.id, id));
    await tx.execute(sql`select pg_notify('reminders_due', '')`); // delivered on commit
    return { mode: r.recurrence ? ("extra" as const) : ("rescheduled" as const) };
  });
}

// A copy to yourself only, over the reminder's channels: "[Test]" email (with
// attachments), Slack DM. Not a delivery: no occurrence, task or follow-up.
export async function sendTest(
  actor: Actor,
  companyId: string,
  id: string,
  deps: { send?: typeof sendMail; slackFetch?: typeof fetch } = {},
) {
  const [r] = await withTenant(companyId, (tx) => tx.select().from(reminders).where(eq(reminders.id, id)));
  if (!r || (await reminderAccess(companyId, actor, r)) !== "full") return { error: "Reminder not found." };
  const appUrl = `${process.env.BETTER_AUTH_URL}/reminders/${r.id}`;
  // A task's due time as if sent right now.
  const due =
    r.isTask && r.dueAfterMinutes
      ? `${formatInZone(new Date(Date.now() + r.dueAfterMinutes * 60_000), r.timeZone)} (${r.timeZone})`
      : undefined;
  const sent: ("email" | "slack")[] = [];

  if (r.channels.includes("email")) {
    const files = await withTenant(companyId, (tx) =>
      tx
        .select({ id: attachments.id, fileName: attachments.fileName, contentType: attachments.contentType, size: attachments.size })
        .from(attachments)
        .where(eq(attachments.reminderId, r.id))
        .orderBy(attachments.createdAt),
    );
    const { attached, tooBig } = await emailFiles(files, (fid) => withTenant(companyId, (tx) => getBlob(tx, fid)));
    const email = renderReminderEmail({ ...r, appUrl, due, tooBig, test: true });
    await (deps.send ?? sendMail)({ to: actor.email, ...email, attachments: attached });
    sent.push("email");
  }
  if (r.channels.includes("slack")) {
    const inst = await getInstallation(companyId);
    if (!inst) return { error: "Slack isn't connected, so the Slack part of the test couldn't be sent.", sent };
    const token = inst.token();
    const slackUser = await lookupByEmail(token, actor.email, deps.slackFetch);
    if (!slackUser) return { error: `You have no Slack account under ${actor.email}, so no Slack test was sent.`, sent };
    const msg = reminderMessage({ title: r.title, description: r.description, links: r.links, appUrl, due, test: true });
    await postMessage(token, await openDm(token, slackUser, deps.slackFetch), `[Test] ${msg.text}`, msg.blocks, deps.slackFetch);
    sent.push("slack");
  }
  return { sent };
}
