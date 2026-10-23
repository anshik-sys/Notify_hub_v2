"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { markAllRead, MUTABLE, setMutes } from "@/lib/notifications";
import { browserLabel, checkSubscription, removePushSubscription, savePushSubscription } from "@/lib/push";
import { clientIp, limits } from "@/lib/rate-limit";
import { requireMember } from "@/lib/session";

// Both act only on the signed-in person's own rows; no permission needed.

export async function markAllReadAction() {
  const { user, companyId } = await requireMember();
  await markAllRead(companyId, user.id);
  redirect("/notifications");
}

// Unticked boxes are the mutes.
export async function savePreferencesAction(fd: FormData) {
  const { user, companyId } = await requireMember();
  const on = new Set(fd.getAll("on").map(String));
  const off = MUTABLE.flatMap((m) => m.channels.map((c) => `${m.event}:${c}`)).filter((k) => !on.has(k));
  await setMutes(companyId, user.id, off);
  redirect(`/notifications/preferences?notice=${encodeURIComponent("Preferences saved.")}`);
}

// PRD 14.7 (PU1, PU3): called from the browser with its PushSubscription.toJSON().
// Returns an error message or null.
export async function savePushAction(raw: unknown) {
  const { user, companyId } = await requireMember();
  const h = await headers();
  const limited = await limits([
    [`push:user:${user.id}`, 20, 3600],
    [`push:ip:${clientIp(h)}`, 60, 3600],
  ]);
  if (limited) return limited;
  const checked = checkSubscription(raw);
  if ("error" in checked) return checked.error;
  await savePushSubscription(companyId, user.id, checked.sub, browserLabel(h.get("user-agent") ?? ""));
  return null;
}

export async function removePushAction(endpoint: unknown) {
  const { user, companyId } = await requireMember();
  if (typeof endpoint !== "string" || endpoint.length > 1000) return "Not found.";
  await removePushSubscription(companyId, user.id, endpoint);
  return null;
}
