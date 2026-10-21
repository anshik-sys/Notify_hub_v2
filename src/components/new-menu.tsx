"use client";

import Link from "next/link";
import { Icon } from "./icon";
import styles from "./new-menu.module.css";

// "+ New ▾": the one form makes all three kinds, so the button offers them and
// opens the form with that kind picked. A native popover (Esc and clicking
// outside close it); picking one navigates, and the shell stays mounted, so
// it's closed by hand (as the calendar's view menu).
const KINDS = [
  { href: "/reminders/new", label: "Reminder", hint: "Tell people something at a set time" },
  { href: "/reminders/new?task=1", label: "Task", hint: "Ask people to do something by a date" },
  { href: "/reminders/new?event=1", label: "Event", hint: "Invite people to be somewhere" },
];

// className / labelClassName: the top bar's own button look (its label hides when narrow).
export function NewMenu({ id, className, labelClassName }: { id: string; className?: string; labelClassName?: string }) {
  const close = () => document.getElementById(id)?.hidePopover();
  return (
    <>
      <button popoverTarget={id} className={className ?? styles.trigger} aria-haspopup="menu" style={{ anchorName: `--${id}` } as React.CSSProperties}>
        <Icon name="plus" />
        <span className={labelClassName}>New</span>
        <span className={labelClassName ? `${styles.chevron} ${labelClassName}` : styles.chevron}>
          <Icon name="down" />
        </span>
      </button>
      <nav id={id} popover="auto" aria-label="Create" className={styles.panel} style={{ positionAnchor: `--${id}` } as React.CSSProperties}>
        {KINDS.map((k) => (
          <Link key={k.label} href={k.href} className={styles.item} onClick={close}>
            <span className={styles.label}>{k.label}</span>
            <span className={styles.hint}>{k.hint}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
