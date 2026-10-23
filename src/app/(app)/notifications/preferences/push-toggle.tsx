"use client";

// PRD 14.7 (PU1-PU3): browser push, turned on per browser. Registers /sw.js,
// asks the browser for permission only when clicked, and saves this browser's
// subscription on the server (savePushAction checks it).
import { useEffect, useState } from "react";
import { Button, Hint } from "@/components/form";
import { removePushAction, savePushAction } from "../actions";

type State = "loading" | "unsupported" | "blocked" | "off" | "on";

// The VAPID public key arrives base64url; the browser wants its bytes.
const keyBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const current = async () => (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription() ?? null;

export function PushToggle({ vapidKey }: { vapidKey: string }) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What this browser can do and has: read once, after the page loads.
  useEffect(() => {
    let live = true;
    const check = async (): Promise<State> => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
      if (Notification.permission === "denied") return "blocked";
      return (await current().catch(() => null)) ? "on" : "off";
    };
    check().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, []);

  async function turnOn() {
    setBusy(true);
    setError(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") return setState("blocked");
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey) });
      const failed = await savePushAction(sub.toJSON());
      if (failed) {
        await sub.unsubscribe();
        return setError(failed);
      }
      setState("on");
    } catch {
      setError("This browser couldn’t turn on push. Try again, or use another browser.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      const sub = await current();
      if (sub) {
        await removePushAction(sub.endpoint);
        await sub.unsubscribe();
      }
      setState("off");
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") return <Hint>Checking this browser…</Hint>;
  if (state === "unsupported") return <Hint>This browser can’t show push notifications. Chrome, Edge, Firefox and Safari (macOS 13 or later) can.</Hint>;
  if (state === "blocked")
    return <Hint>Notifications are blocked for NotifyHub in this browser. Allow them in the browser’s site settings (the icon left of the address), then reload this page.</Hint>;
  return (
    <>
      <Hint>
        {state === "on"
          ? "On in this browser. Other browsers you use have their own setting."
          : "Off in this browser. Turn it on to get a desktop notification for everything in your notifications, even when NotifyHub isn’t open."}
      </Hint>
      {error && <Hint>{error}</Hint>}
      <div>
        <Button type="button" variant={state === "on" ? "secondary" : "primary"} disabled={busy} onClick={state === "on" ? turnOff : turnOn}>
          {state === "on" ? "Turn off in this browser" : "Turn on in this browser"}
        </Button>
      </div>
    </>
  );
}
