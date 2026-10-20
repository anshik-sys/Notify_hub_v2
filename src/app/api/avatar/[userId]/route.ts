import { notFound } from "next/navigation";
import { requireMember } from "@/lib/session";
import { photoFile } from "@/lib/users";
import { isUserId } from "@/lib/validate";

// A profile photo (PRD 3.3). Signed-in members of the same company only (RLS):
// unlike the logo, no email needs it. Only ever an image we checked by its
// bytes (setPhoto); nosniff so it's never treated as anything else. URLs carry
// ?v=<version> (photoUrls), so it can be cached for long, privately.
export async function GET(_req: Request, ctx: RouteContext<"/api/avatar/[userId]">) {
  const { userId } = await ctx.params;
  if (!isUserId(userId)) notFound();
  const { companyId } = await requireMember();
  const photo = await photoFile(companyId, userId);
  if (!photo) notFound();
  return new Response(new Uint8Array(photo.data), {
    headers: {
      "Content-Type": photo.contentType,
      "Content-Length": String(photo.data.length),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
