"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { respondByToken } from "@/lib/events";
import { ANSWER_LABEL, isAnswer, readRsvp } from "@/lib/invite";
import { auth } from "@/lib/auth";
import { clientIp, limits } from "@/lib/rate-limit";

// The reply pop-up's answer (PRD 14.3, RS2). No sign-in needed: the token
// names the guest. Afterwards the pop-up closes onto the dashboard when it's
// the guest's own session, or onto sign-in otherwise.
export async function answerInviteAction(fd: FormData) {
  const token = String(fd.get("token") ?? "");
  const answer = fd.get("answer");
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  const own = Boolean(session && session.user.id === readRsvp(token)?.userId);
  const again = (error: string) =>
    redirect(own ? `/?rsvp=${encodeURIComponent(token)}&error=${encodeURIComponent(error)}` : `/rsvp/${encodeURIComponent(token)}?error=${encodeURIComponent(error)}`);
  const limited = await limits([[`rsvp:ip:${clientIp(h)}`, 60, 3600]]);
  if (limited) again(limited);
  const error = await respondByToken(token, answer);
  if (error) again(error);
  const notice = encodeURIComponent(`Answer saved: ${isAnswer(answer) ? ANSWER_LABEL[answer] : ""}. You can change it on the event's page.`);
  redirect(own ? `/?notice=${notice}` : `/sign-in?notice=${notice}`);
}
