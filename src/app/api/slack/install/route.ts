import { randomBytes } from "node:crypto";
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { authorizeUrl, SLACK_SCOPES } from "@/lib/slack";
import { STATE_COOKIE } from "@/lib/slack-installations";

// "Add to Slack": the state is random, kept in an httpOnly cookie bound to
// this company and user, and checked on the way back (CSRF).
export async function GET() {
  const { user, companyId, access } = await requireMember();
  if (!can(access, "company.manage_integrations")) notFound();
  const state = randomBytes(16).toString("hex");
  const url = new URL(authorizeUrl());
  url.searchParams.set("client_id", process.env.SLACK_CLIENT_ID ?? "");
  url.searchParams.set("scope", SLACK_SCOPES.join(","));
  url.searchParams.set("redirect_uri", `${process.env.BETTER_AUTH_URL}/api/slack/oauth`);
  url.searchParams.set("state", state);
  const res = NextResponse.redirect(url);
  res.cookies.set(STATE_COOKIE, `${state}.${companyId}.${user.id}`, {
    httpOnly: true,
    sameSite: "lax", // sent on Slack's top-level redirect back
    secure: process.env.NODE_ENV === "production",
    path: "/api/slack",
    maxAge: 600,
  });
  return res;
}
