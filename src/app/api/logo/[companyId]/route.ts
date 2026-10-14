import { logoFile } from "@/lib/company";
import { isUuid } from "@/lib/validate";

// The company's logo, for the app and for emails (PRD 4, 7.1). Public: mail
// clients fetch it without a session, and a logo isn't secret. Only ever an
// image we checked by its bytes (setLogo); nosniff so it's never treated as
// anything else. URLs carry ?v=<version>, so it can be cached for long.
export async function GET(_request: Request, ctx: RouteContext<"/api/logo/[companyId]">) {
  const { companyId } = await ctx.params;
  const logo = isUuid(companyId) ? await logoFile(companyId) : null;
  if (!logo) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(logo.data), {
    headers: {
      "Content-Type": logo.contentType,
      "Content-Length": String(logo.data.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
