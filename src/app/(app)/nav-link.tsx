"use client";

// Client component only to know the current path for the active link.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/icon";
import styles from "./layout.module.css";

export function NavLink({ href, icon, children }: { href: string; icon: IconName; children: string }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  return (
    // data-label: the tooltip when the sidebar is collapsed to icons.
    <Link href={href} className={styles.navItem} aria-current={active ? "page" : undefined} data-label={children}>
      <Icon name={icon} />
      <span className={styles.label}>{children}</span>
    </Link>
  );
}

// The shell stays mounted across client navigations, so an open popover menu
// would stay open on the new page. Close it whenever the path changes.
export function ClosePopoverOnNavigate({ id }: { id: string }) {
  const path = usePathname();
  useEffect(() => {
    const el = document.getElementById(id);
    if (el?.matches(":popover-open")) el.hidePopover();
  }, [id, path]);
  return null;
}

// Collapses the sidebar to an icon rail. The shell reads the cookie on the
// server, so the next page load is already in the right state (no flash).
export function SidebarToggle({ collapsed: initial }: { collapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(initial);
  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    document.getElementById("frame")?.toggleAttribute("data-collapsed", next);
    // Same cookie name as the shell reads (layout.tsx).
    document.cookie = `sidebar=${next ? "collapsed" : "open"}; path=/; max-age=31536000; samesite=lax`;
  }
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <button type="button" onClick={toggle} className={styles.navItem} aria-expanded={!collapsed} aria-controls="sidebar" data-label={label}>
      <Icon name="sidebar" />
      <span className={styles.label}>{label}</span>
    </button>
  );
}
