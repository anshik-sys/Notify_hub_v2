import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { googleAllowed, GOOGLE_STATE_COOKIE } from "@/lib/google-calendar";
import { consentUrl } from "@/lib/google";
import { limits } from "@/lib/rate-limit";
import { requireMember } from "@/lib/session";

// Section 13, "Connect Google Calendar": a personal setting, so no permission
// beyond being a member. The state is random, kept in an httpOnly cookie bound
// to this person, and checked on the way back (CSRF), as for Slack.
export async function GET() {
  const { user, companyId } = await requireMember();
  const back = (q: string) => NextResponse.redirect(new URL(`/settings/profile?${q}`, process.env.BETTER_AUTH_URL));
  if (!(await googleAllowed(companyId))) return back("error=" + encodeURIComponent("Google Calendar is turned off for your company."));
  const limited = await limits([[`google-connect:user:${user.id}`, 10, 3600]]);
  if (limited) return back("error=" + encodeURIComponent(limited));
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(consentUrl(state));
  res.cookies.set(GOOGLE_STATE_COOKIE, `${state}.${companyId}.${user.id}`, {
    httpOnly: true,
    sameSite: "lax", // sent on Google's top-level redirect back
    secure: process.env.NODE_ENV === "production",
    path: "/api/google",
    maxAge: 600,
  });
  return res;
}
