"use client";

// Live preview of the email and the Slack message, built with the same
// functions the real sends use (renderReminderEmail, reminderMessage), from
// whatever is in the form right now. The email HTML goes in a sandboxed iframe
// (no scripts, no access to this page); Slack blocks render as plain text.
import { useEffect, useRef, useState } from "react";
import { renderReminderEmail } from "@/lib/email-render";
import { reminderMessage } from "@/lib/slack";
import styles from "./preview.module.css";

type Values = {
  title: string;
  description: string;
  senderName: string;
  links: { label: string; url: string }[];
  due?: string;
  slack: boolean;
};

function read(form: HTMLFormElement, defaultSender: string, timeZone: string): Values {
  const fd = new FormData(form);
  const str = (k: string) => String(fd.get(k) ?? "").trim();
  const labels = fd.getAll("linkLabel").map(String);
  const links = fd
    .getAll("linkUrl")
    .map(String)
    .flatMap((raw, i) => {
      try {
        const url = new URL(raw.trim());
        return url.protocol === "http:" || url.protocol === "https:" ? [{ label: labels[i]?.trim() || url.hostname, url: url.href }] : [];
      } catch {
        return [];
      }
    });
  const due = fd.get("isTask") === "on" && str("due") ? `${str("due").replace("T", " ")} (${timeZone})` : undefined;
  return {
    title: str("title") || "Your title",
    description: str("description"),
    senderName: str("senderName") || defaultSender,
    links: links.slice(0, 10),
    due,
    slack: fd.getAll("channels").includes("slack"),
  };
}

// Slack mrkdwn to readable text: <url|label> -> label, entities decoded.
const unSlack = (t: string) =>
  t.replace(/<[^|>]+\|([^>]+)>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\*/g, "");

type Block = { type: string; text?: { text: string }; elements?: { text: string | { text: string } }[] };

export function ReminderPreview({ defaultSender, timeZone }: { defaultSender: string; timeZone: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [v, setV] = useState<Values | null>(null);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const update = () => setV(read(form, defaultSender, timeZone));
    update();
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    return () => {
      form.removeEventListener("input", update);
      form.removeEventListener("change", update);
    };
  }, [defaultSender, timeZone]);

  const appUrl = "https://notifyhub.app/reminders/…";
  const email = v && renderReminderEmail({ ...v, appUrl });
  const slack = v?.slack
    ? (reminderMessage({ ...v, appUrl, task: v.due ? { occurrenceId: "preview", dm: true } : undefined }).blocks as Block[])
    : null;

  return (
    <div ref={ref} className={styles.wrap}>
      {!email ? (
        <p className={styles.muted}>The preview appears here.</p>
      ) : (
        <>
          <div className={styles.card} aria-label="Email preview">
            <div className={styles.head}>
              <span>
                <strong>From:</strong> {email.fromName}
              </span>
              <span>
                <strong>Subject:</strong> {email.subject}
              </span>
            </div>
            <iframe
              title="Email body preview"
              sandbox=""
              className={styles.frame}
              srcDoc={`<!doctype html><meta charset="utf-8"><body style="font:15px/1.5 system-ui,sans-serif;margin:12px;color:#171717">${email.html}</body>`}
            />
          </div>
          {slack && (
            <div className={styles.card} aria-label="Slack preview">
              <div className={styles.head}>
                <strong>Slack</strong>
              </div>
              <div className={styles.slack}>
                {slack.map((b, i) =>
                  b.type === "header" ? (
                    <p key={i} className={styles.slackHeader}>
                      {b.text?.text}
                    </p>
                  ) : b.type === "section" ? (
                    <p key={i} className={styles.slackText}>
                      {unSlack(b.text?.text ?? "")}
                    </p>
                  ) : b.type === "context" ? (
                    <p key={i} className={styles.muted}>
                      {b.elements?.map((e) => (typeof e.text === "string" ? e.text : e.text.text)).join(" ")}
                    </p>
                  ) : b.type === "actions" ? (
                    <div key={i} className={styles.buttons}>
                      {b.elements?.map((e, j) => (
                        <span key={j} className={styles.chip}>
                          {typeof e.text === "string" ? e.text : e.text.text}
                        </span>
                      ))}
                    </div>
                  ) : null,
                )}
              </div>
            </div>
          )}
          <p className={styles.muted}>Attachments are added to the email when it’s sent (up to 20 MB).</p>
        </>
      )}
    </div>
  );
}
