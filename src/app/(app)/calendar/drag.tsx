"use client";

import { useEffect, useRef, useState } from "react";
import { moveEntryAction } from "../reminders/actions";
import styles from "./drag.module.css";

type Dropped = { id: string; at: string; local: string; scopes: string[]; to: string; x: number; y: number };
const LABEL: Record<string, string> = { one: "This one", following: "This and following", all: "All" };

// PRD 14.2 drag to reschedule (M1, M5). Entries the viewer may change carry
// data-drag-* (entry.tsx); the empty slots (data-quick-at, from quick create)
// are where they land. In an hour row the lower half means :30; a day in
// Month view keeps the entry's time of day. A one-time reminder moves at
// once; a series first asks which dates (a native popover: Esc cancels).
// The server (moveEntry) checks everything again. Keyboard: "Move to…" on
// the entry's card.
export function DragMove({ next }: { next: string }) {
  const form = useRef<HTMLFormElement>(null);
  const ask = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<Dropped | null>(null);

  useEffect(() => {
    // Pointer events, not HTML5 drag and drop: some browsers won't drag a
    // <button>, and where a press lands inside one changes whether it starts.
    let press: { el: HTMLElement; x: number; y: number } | null = null;
    let dragging = false;
    let over: HTMLElement | null = null;
    const slotAt = (x: number, y: number) =>
      document.elementsFromPoint(x, y).find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.quickAt !== undefined) ?? null;
    const mark = (el: HTMLElement | null) => {
      over?.classList.remove(styles.target);
      el?.classList.add(styles.target);
      over = el;
    };
    const onDown = (e: PointerEvent) => {
      const el = e.button === 0 ? (e.target as Element).closest<HTMLElement>("[data-drag-id]") : null;
      press = el ? { el, x: e.clientX, y: e.clientY } : null;
    };
    const onMove = (e: PointerEvent) => {
      if (!press) return;
      if (!dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
      dragging = true;
      press.el.classList.add(styles.dragging);
      document.documentElement.classList.add(styles.grabbing);
      mark(slotAt(e.clientX, e.clientY));
    };
    const onUp = (e: PointerEvent) => {
      if (!press) return;
      const { el } = press;
      const slot = dragging ? slotAt(e.clientX, e.clientY) : null;
      el.classList.remove(styles.dragging);
      document.documentElement.classList.remove(styles.grabbing);
      mark(null);
      const wasDrag = dragging;
      press = null;
      dragging = false;
      if (!wasDrag) return; // a plain click: the card opens as usual
      // The click that follows a drag mustn't open the card. It comes right
      // after this pointerup if at all, so the guard goes away on the next tick.
      const swallow = (c: MouseEvent) => (c.preventDefault(), c.stopPropagation());
      document.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 0);
      if (!slot) return;
      const d = el.dataset;
      const target = slot.dataset.quickAt!;
      const lower = e.clientY - slot.getBoundingClientRect().top > slot.offsetHeight / 2;
      const to =
        slot.dataset.half !== undefined
          ? lower
            ? target.replace(/:00$/, ":30")
            : target
          : `${target.slice(0, 10)}T${d.dragLocal!.slice(11, 16)}`; // Month: same time, new day
      if (to === d.dragLocal) return;
      setDrop({ id: d.dragId!, at: d.dragAt!, local: d.dragLocal!, scopes: d.dragScopes ? d.dragScopes.split(",") : [], to, x: e.clientX, y: e.clientY });
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, []);

  // A one-time reminder moves at once; a series asks first. The question opens
  // just after the drop: the mouse release that ends a drag would otherwise
  // count as a click outside and close it straight away.
  useEffect(() => {
    if (!drop) return;
    if (!drop.scopes.length) return form.current?.requestSubmit();
    const t = setTimeout(() => ask.current?.showPopover(), 60);
    return () => clearTimeout(t);
  }, [drop]);

  return (
    <form ref={form} action={moveEntryAction}>
      <input type="hidden" name="id" value={drop?.id ?? ""} />
      <input type="hidden" name="occursAt" value={drop?.at ?? ""} />
      <input type="hidden" name="at" value={drop?.to ?? ""} />
      <input type="hidden" name="next" value={next} />
      {!drop?.scopes.length && <input type="hidden" name="scope" value="one" />}
      <div
        ref={ask}
        popover="auto"
        role="dialog"
        aria-label="Move which dates?"
        className={styles.ask}
        style={drop ? { top: Math.min(drop.y, window.innerHeight - 200), left: Math.min(drop.x, window.innerWidth - 300) } : undefined}
        onToggle={(e) => e.newState === "closed" && setDrop(null)}
      >
        <p className={styles.title}>Move this repeating reminder</p>
        <div className={styles.buttons}>
          {drop?.scopes.map((sc) => (
            <button key={sc} name="scope" value={sc} className={styles.choice}>
              {LABEL[sc]}
            </button>
          ))}
        </div>
      </div>
    </form>
  );
}
