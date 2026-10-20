"use client";

import Link from "next/link";
import { Icon } from "@/components/icon";
import styles from "./view-menu.module.css";

// "Month ▾": a native popover listing the views (Esc and clicking outside close
// it). Picking one navigates and closes it; the page stays mounted across that
// navigation, so it has to be closed by hand.
export function ViewMenu({ label, items }: { label: string; items: { href: string; label: string; current: boolean }[] }) {
  const close = () => document.getElementById("view-menu")?.hidePopover();
  return (
    <>
      <button popoverTarget="view-menu" className={styles.trigger} aria-haspopup="menu">
        {label}
        <span className={styles.chevron}>
          <Icon name="down" />
        </span>
      </button>
      <nav id="view-menu" popover="auto" aria-label="Views" className={styles.panel}>
        {items.map((i) => (
          <Link key={i.label} href={i.href} className={i.current ? `${styles.item} ${styles.current}` : styles.item} aria-current={i.current ? "page" : undefined} onClick={close}>
            {i.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
