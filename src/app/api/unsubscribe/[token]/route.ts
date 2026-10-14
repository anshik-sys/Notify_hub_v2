import { clientIp, limits } from "@/lib/rate-limit";
import { unsubscribe } from "@/lib/unsubscribe";

// RFC 8058 one-click: mail apps POST here from the List-Unsubscribe header
// (body "List-Unsubscribe=One-Click"). POST only; people use /unsubscribe/<token>.
export async function POST(request: Request, ctx: RouteContext<"/api/unsubscribe/[token]">) {
  const { token } = await ctx.params;
  if (await limits([[`unsubscribe:ip:${clientIp(request.headers)}`, 30, 3600]])) return new Response(null, { status: 429 });
  const error = await unsubscribe(token);
  return new Response(null, { status: error ? 400 : 200 });
}
