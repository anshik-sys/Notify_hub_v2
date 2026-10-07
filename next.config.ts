import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Reminder attachments: up to 5 files x 10 MB per save, plus multipart
      // overhead. Any proxy/WAF in front must allow at least this much.
      bodySizeLimit: "55mb",
    },
  },
};

export default nextConfig;
