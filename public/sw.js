// PRD 14.7 browser push. At the site root so it covers every page; only this
// file may run as a worker (CSP worker-src 'self'). Shows what the worker
// (src/worker/push.ts) sends: { title, body, url, tag }. The same tag replaces
// an earlier notification instead of showing it twice (a retried send).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || "NotifyHub", { body: d.body, tag: d.tag, icon: "/logo.png", data: { url: d.url } }));
});

// PU10: open the item in a NotifyHub tab if one is open, else in a new one.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/notifications";
  e.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const tab = tabs.find((c) => new URL(c.url).origin === self.location.origin);
      if (tab) {
        await tab.focus();
        return tab.navigate(url).catch(() => self.clients.openWindow(url));
      }
      return self.clients.openWindow(url);
    })(),
  );
});
