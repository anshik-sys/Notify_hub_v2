import { type NextRequest, NextResponse } from "next/server";
import { connectGoogle, GOOGLE_STATE_COOKIE } from "@/lib/google-calendar";
import { requireMember } from "@/lib/session";

// Google sends the person back here after Allow (or Cancel, GC3).
export async function GET(req: NextRequest) {
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/settings/profile?${q}#google`, process.env.BETTER_AUTH_URL));
    res.cookies.delete({ name: GOOGLE_STATE_COOKIE, path: "/api/google" });
    return res;
  };
  const { user, companyId } = await requireMember();
  const [state, cookieCompany, cookieUser] = (req.cookies.get(GOOGLE_STATE_COOKIE)?.value ?? "").split(".");
  const params = req.nextUrl.searchParams;
  // Same browser, same company, same person who clicked Connect.
  if (!state || state !== params.get("state") || cookieCompany !== companyId || cookieUser !== user.id)
    return back("error=" + encodeURIComponent("The Google connection expired or didn't match. Try again."));
  if (params.get("error")) return back("error=" + encodeURIComponent("Google Calendar wasn't connected: access was cancelled."));
  const error = await connectGoogle(companyId, user.id, params.get("code") ?? "");
  return back(error ? "error=" + encodeURIComponent(error) : "notice=" + encodeURIComponent("Google Calendar connected. Your NotifyHub calendar fills in within a minute."));
}
