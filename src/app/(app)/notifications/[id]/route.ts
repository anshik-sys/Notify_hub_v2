import { notFound, redirect } from "next/navigation";
import { openNotification } from "@/lib/notifications";
import { requireMember } from "@/lib/session";
import { isUuid } from "@/lib/validate";

// A click in the notification centre: mark it read, then go to it. A route
// rather than marking read inside the reminder page, because the layout's
// unread count renders alongside the page and would still show it.
// It only changes the signed-in person's own read state.
export async function GET(_req: Request, ctx: RouteContext<"/notifications/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) notFound();
  const { user, companyId } = await requireMember();
  const to = await openNotification(companyId, user.id, id);
  if (!to) notFound();
  redirect(to);
}
