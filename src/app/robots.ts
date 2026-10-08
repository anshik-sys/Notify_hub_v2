import type { MetadataRoute } from "next";

// A private app: nothing to index (PRD 11.1). X-Robots-Tag says the same.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
