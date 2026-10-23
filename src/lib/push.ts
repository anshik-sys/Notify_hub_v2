import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { pushSubscriptions } from "@/db/schema";

// PRD 14.7 browser push: the browsers a person turned push on in. The worker
// (src/worker/push.ts) sends to them.

// The worker POSTs to the endpoint, so only the browser vendors' push
// services are accepted: anything else would let a user aim our server at any
// URL. Chrome uses Google's, Safari Apple's, Firefox Mozilla's, Edge Microsoft's.
const PUSH_HOSTS = ["fcm.googleapis.com", ".push.apple.com", ".push.services.mozilla.com", ".notify.windows.com"];
const KEY = /^[A-Za-z0-9_-]{16,200}$/;

export type Subscription = { endpoint: string; p256dh: string; auth: string };

// What the browser's PushSubscription.toJSON() gives, checked.
export function checkSubscription(raw: unknown): { sub: Subscription } | { error: string } {
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const [endpoint, p256dh, auth] = [r?.endpoint, r?.keys?.p256dh, r?.keys?.auth];
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string" || endpoint.length > 1000)
    return { error: "This browser's push details weren't readable." };
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { error: "This browser's push details weren't readable." };
  }
  const known = PUSH_HOSTS.some((h) => (h.startsWith(".") ? url.hostname.endsWith(h) : url.hostname === h));
  if (url.protocol !== "https:" || !known) return { error: "This browser's push service isn't supported." };
  if (!KEY.test(p256dh) || !KEY.test(auth)) return { error: "This browser's push details weren't readable." };
  return { sub: { endpoint, p256dh, auth } };
}

// "Chrome on macOS", for Download my data. Order matters: Edge says Chrome too, Chrome says Safari.
export function browserLabel(ua: string) {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "another system";
  return `${browser} on ${os}`;
}

// The same browser turned on again replaces its old keys. An endpoint saved
// under another company stays theirs (RLS hides it): nothing is saved.
export async function savePushSubscription(companyId: string, userId: string, sub: Subscription, label: string) {
  await withTenant(companyId, async (tx) => {
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
    await tx.insert(pushSubscriptions).values({ companyId, userId, ...sub, label }).onConflictDoNothing();
  });
}

// PU3: only this browser; only your own.
export async function removePushSubscription(companyId: string, userId: string, endpoint: string) {
  await withTenant(companyId, (tx) =>
    tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId))),
  );
}

export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY || null;
