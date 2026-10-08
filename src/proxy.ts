import { NextRequest, NextResponse } from "next/server";

// Content Security Policy with a fresh nonce per request (PRD 11.1). Next
// reads the nonce from this header and puts it on its own <script> tags, so
// only our scripts run. Every page is dynamic (requireMember reads headers),
// which nonces need. Don't loosen this casually: an inline <script> without
// the nonce is meant to be blocked.
// - style-src-attr 'unsafe-inline': style="" attributes (report bars), not <style>;
// - frame-src 'self': the email preview's sandboxed srcdoc iframe;
// - form-action: Google sign-in and Slack connect redirect out from a form post.
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const https = (process.env.BETTER_AUTH_URL ?? "").startsWith("https://");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "frame-src 'self'",
    "form-action 'self' https://accounts.google.com https://slack.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
