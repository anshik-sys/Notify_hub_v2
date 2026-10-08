import type { NextConfig } from "next";

const https = (process.env.BETTER_AUTH_URL ?? "").startsWith("https://");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Dev only: lets the dev server answer through an ngrok tunnel, which a real
  // Slack app needs (https redirect + interactivity URL). See DEPLOYMENT.md.
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.app"],
  experimental: {
    serverActions: {
      // Reminder attachments: up to 5 files x 10 MB per save, plus multipart
      // overhead. Any proxy/WAF in front must allow at least this much.
      bodySizeLimit: "55mb",
    },
  },
  // PRD 11.1 web hardening, on every response (the CSP is set per request in
  // src/proxy.ts because it carries a nonce). HSTS only once served over https.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          ...(https ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
