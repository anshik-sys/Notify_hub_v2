import { eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { slackInstallations } from "@/db/schema";
import { decrypt, encrypt } from "./crypto";
import { listChannels, revoke } from "./slack";

// "Add to Slack" CSRF state cookie (set by /api/slack/install, checked by /api/slack/oauth).
export const STATE_COOKIE = "slack_oauth_state";

// The company's Slack connection. The token is decrypted only server-side,
// only when a call is about to be made.

export async function getInstallation(companyId: string) {
  const [row] = await withTenant(companyId, (tx) =>
    tx
      .select({
        teamId: slackInstallations.teamId,
        teamName: slackInstallations.teamName,
        fallbackChannelId: slackInstallations.fallbackChannelId,
        fallbackChannelName: slackInstallations.fallbackChannelName,
        tokenEnc: slackInstallations.botTokenEnc,
      })
      .from(slackInstallations)
      .where(eq(slackInstallations.companyId, companyId)),
  );
  if (!row) return null;
  const { tokenEnc, ...rest } = row;
  return { ...rest, token: () => decrypt(tokenEnc) };
}

export async function saveInstallation(
  companyId: string,
  installedBy: string,
  i: { teamId: string; teamName: string; token: string; botUserId: string },
) {
  const values = { teamId: i.teamId, teamName: i.teamName, botTokenEnc: encrypt(i.token), botUserId: i.botUserId, installedBy };
  try {
    await withTenant(companyId, (tx) =>
      tx
        .insert(slackInstallations)
        .values({ companyId, ...values })
        .onConflictDoUpdate({ target: slackInstallations.companyId, set: values }),
    );
  } catch (e) {
    // unique(team_id): this workspace is already another company's.
    if ((e as { cause?: { code?: string } }).cause?.code === "23505")
      return "That Slack workspace is already connected to another NotifyHub company.";
    throw e;
  }
  return null;
}

export async function disconnect(companyId: string) {
  const inst = await getInstallation(companyId);
  if (!inst) return;
  await revoke(inst.token()).catch(() => {}); // best effort: the row goes either way
  await withTenant(companyId, (tx) => tx.delete(slackInstallations).where(eq(slackInstallations.companyId, companyId)));
}

export async function setFallbackChannel(companyId: string, channelId: string | null) {
  const inst = await getInstallation(companyId);
  if (!inst) return "Slack isn't connected.";
  const channel = channelId ? (await listChannels(inst.token())).find((c) => c.id === channelId) : null;
  if (channelId && !channel) return "That channel doesn't exist.";
  await withTenant(companyId, (tx) =>
    tx
      .update(slackInstallations)
      .set({ fallbackChannelId: channel?.id ?? null, fallbackChannelName: channel?.name ?? null })
      .where(eq(slackInstallations.companyId, companyId)),
  );
  return null;
}

// Channels for pickers; [] when not connected or Slack is unreachable (the
// form still works for email).
export async function channelChoices(companyId: string) {
  const inst = await getInstallation(companyId);
  if (!inst) return null;
  try {
    return await listChannels(inst.token());
  } catch (e) {
    console.error("listing Slack channels failed", e);
    return [];
  }
}
