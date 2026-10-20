"use client";

import { useEffect, useRef, useState } from "react";
import { quickCreateAction } from "../reminders/actions";
import styles from "./quick-create.module.css";

export const QUICK_ID = "quick-create";

// PRD 14.2 quick create (Q1–Q6). The grid's empty slots are buttons with
// popovertarget={QUICK_ID} and data-quick-at="YYYY-MM-DDTHH:MM"; this one
// shared box (a native popover: Esc and clicking outside close it) takes the
// clicked slot's time and sits beside it. In an hour row, clicking its lower
// half picks :30. "More options" opens the full form with what's typed.
export function QuickCreate({ next }: { next: string }) {
  const box = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [at, setAt] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"reminder" | "task" | "event">("reminder");

  useEffect(() => {
    let anchored: HTMLElement | null = null;
    const onClick = (e: MouseEvent) => {
      const slot = (e.target as Element).closest<HTMLElement>("[data-quick-at]");
      if (!slot) return;
      let value = slot.dataset.quickAt!;
      if (slot.dataset.half !== undefined && e.offsetY > slot.offsetHeight / 2) value = value.replace(/:00$/, ":30");
      setAt(value);
      // Anchor the box to this slot (CSS anchor positioning; centred where unsupported).
      anchored?.style.removeProperty("anchor-name");
      slot.style.setProperty("anchor-name", "--quick-slot");
      anchored = slot;
    };
    document.addEventListener("click", onClick, true);
    const el = box.current;
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === "open") requestAnimationFrame(() => titleRef.current?.focus());
      else setTitle("");
    };
    el?.addEventListener("toggle", onToggle);
    return () => {
      document.removeEventListener("click", onClick, true);
      el?.removeEventListener("toggle", onToggle);
    };
  }, []);

  const more = `/reminders/new?${new URLSearchParams({ title, at, ...(kind === "task" && { task: "1" }), ...(kind === "event" && { event: "1" }) })}`;
  return (
    <div id={QUICK_ID} ref={box} popover="auto" role="dialog" aria-label="Quick create" className={styles.box}>
      <form action={quickCreateAction} className={styles.form}>
        <input type="hidden" name="next" value={next} />
        <input
          ref={titleRef}
          name="title"
          required
          maxLength={200}
          placeholder="Add a title"
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={styles.title}
        />
        <div className={styles.kinds} role="radiogroup" aria-label="Type">
          {(["reminder", "task", "event"] as const).map((k) => (
            <label key={k} className={kind === k ? `${styles.kind} ${styles.on}` : styles.kind}>
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
              {k === "reminder" ? "Reminder" : k === "task" ? "Task" : "Event"}
            </label>
          ))}
        </div>
        <label className={styles.field}>
          When
          <input type="datetime-local" name="at" required value={at} onChange={(e) => setAt(e.target.value)} className={styles.input} />
        </label>
        <p className={styles.hint}>
          {kind === "event" ? "One hour, just you. Add guests and a place in More options." : "To you, by email."}
          {kind === "task" && " Due an hour after it's sent."}
        </p>
        <div className={styles.buttons}>
          <a href={more} className={styles.more}>
            More options
          </a>
          <button className={styles.save}>Save</button>
        </div>
      </form>
    </div>
  );
}
