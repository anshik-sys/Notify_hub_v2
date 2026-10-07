import { notFound } from "next/navigation";
import { type NextRequest, NextResponse } from "next/server";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { oauthAccess } from "@/lib/slack";
import { saveInstallation, STATE_COOKIE } from "@/lib/slack-installations";

// Slack sends the admin back here after "Allow".
export async function GET(req: NextRequest) {
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/settings/integrations?${q}`, process.env.BETTER_AUTH_URL));
    res.cookies.delete({ name: STATE_COOKIE, path: "/api/slack" });
    return res;
  };
  const { user, companyId, access } = await requireMember();
  if (!can(access, "company.manage_integrations")) notFound();

  const [state, cookieCompany, cookieUser] = (req.cookies.get(STATE_COOKIE)?.value ?? "").split(".");
  const params = req.nextUrl.searchParams;
  // Same browser, same company, same person who clicked Connect.
  if (!state || state !== params.get("state") || cookieCompany !== companyId || cookieUser !== user.id)
    return back("error=" + encodeURIComponent("The Slack connection expired or didn't match. Try again."));
  if (params.get("error")) return back("error=" + encodeURIComponent("Slack connection was cancelled."));

  let install;
  try {
    install = await oauthAccess(params.get("code") ?? "", `${process.env.BETTER_AUTH_URL}/api/slack/oauth`);
  } catch (e) {
    console.error("Slack OAuth exchange failed", e);
    return back("error=" + encodeURIComponent("Slack didn't accept the connection. Try again."));
  }
  const error = await saveInstallation(companyId, user.id, install);
  return back(error ? "error=" + encodeURIComponent(error) : "notice=" + encodeURIComponent(`Connected to ${install.teamName}.`));
}
