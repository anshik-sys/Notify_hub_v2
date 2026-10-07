"use server";

import { redirect } from "next/navigation";
import { markAllRead, MUTABLE, setMutes } from "@/lib/notifications";
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
