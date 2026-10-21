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
  const page = `/rsvp/${encodeURIComponent(token)}`;
  const again = (error: string) =>
    redirect(own ? `/?rsvp=${encodeURIComponent(token)}&error=${encodeURIComponent(error)}` : `${page}?error=${encodeURIComponent(error)}`);
  // Signed in as someone else: never answer for the link's guest from their session.
  if (session && !own) again("This invite is for someone else. Sign out first if it’s yours.");
  const limited = await limits([[`rsvp:ip:${clientIp(h)}`, 60, 3600]]);
  if (limited) again(limited);
  const error = await respondByToken(token, answer);
  if (error) again(error);
  if (!own) redirect(`${page}?saved=1`); // signed out: the pop-up says it's saved, for whom
  const notice = encodeURIComponent(`Answer saved: ${isAnswer(answer) ? ANSWER_LABEL[answer] : ""}. You can change it on the event's page.`);
  redirect(`/?notice=${notice}`);
}

// "Not you?": sign out, then back to the link to answer as its guest.
export async function signOutForInviteAction(fd: FormData) {
  const token = String(fd.get("token") ?? "");
  await auth.api.signOut({ headers: await headers() });
  redirect(`/rsvp/${encodeURIComponent(token)}`);
}
