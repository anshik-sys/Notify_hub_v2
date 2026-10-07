import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { withTenant } from "@/db";
import { attachments, reminders } from "@/db/schema";
import { reminderAccess } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { getBlob } from "@/lib/storage";
import { isUuid } from "@/lib/validate";

// Download an attachment. Two checks, on purpose: RLS (same company) and the
// reminder's own visibility rules (creator, approvers, managers, recipients).
// Always served as a download with the sniffed type and nosniff, so a file can
// never run as a page on our origin.
export async function GET(_req: Request, ctx: RouteContext<"/api/attachments/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) notFound();
  const { user, companyId, access } = await requireMember();
  const file = await withTenant(companyId, async (tx) => {
    const [row] = await tx
      .select({ meta: attachments, createdBy: reminders.createdBy })
      .from(attachments)
      .innerJoin(reminders, eq(reminders.id, attachments.reminderId))
      .where(eq(attachments.id, id));
    if (!row) return null;
    return { ...row, data: await getBlob(tx, id) };
  });
  if (!file?.data) notFound();
  const seeAs = await reminderAccess(companyId, { id: user.id, email: user.email, access }, { id: file.meta.reminderId, createdBy: file.createdBy });
  if (!seeAs) notFound();

  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.meta.contentType,
      "Content-Length": String(file.data.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.meta.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

