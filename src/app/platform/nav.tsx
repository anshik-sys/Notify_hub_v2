"use client";

// Client component only to know the current path for the active link.
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./layout.module.css";

const LINKS = [
  { href: "/platform", label: "Companies", active: (p: string) => p === "/platform" || p.startsWith("/platform/companies") },
  { href: "/platform/settings", label: "Settings", active: (p: string) => p.startsWith("/platform/settings") },
  { href: "/account/security", label: "Security", active: () => false },
];

export function PlatformNav() {
  const path = usePathname();
  return (
    <nav className={styles.nav} aria-label="Platform">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={styles.navItem} aria-current={l.active(path) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
