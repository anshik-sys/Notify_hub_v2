import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";
import { withTenant } from "@/db";
import { reminders } from "@/db/schema";
import { coverFile, reminderAccess } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { isUuid } from "@/lib/validate";

// A task's cover image (PRD 14.5). Two checks, like attachments: RLS (same
// company) and whether this person can open the task (CV3). Only ever an image
// we checked by its bytes (checkCover); nosniff so it's never anything else.
// URLs carry ?v=<version> (coverUrl), so it can be cached for long, privately.
export async function GET(_req: Request, ctx: RouteContext<"/api/cover/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) notFound();
  const { user, companyId, access } = await requireMember();
  const [r] = await withTenant(companyId, (tx) =>
    tx.select({ id: reminders.id, createdBy: reminders.createdBy }).from(reminders).where(and(eq(reminders.id, id), isNull(reminders.deletedAt))),
  );
  if (!r || !(await reminderAccess(companyId, { id: user.id, email: user.email, access }, r))) notFound();
  const cover = await coverFile(companyId, id);
  if (!cover) notFound();
  return new Response(new Uint8Array(cover.data), {
    headers: {
      "Content-Type": cover.contentType,
      "Content-Length": String(cover.data.length),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
