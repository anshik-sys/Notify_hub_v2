"use client";

// Client components only to know the current path for the active item.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/icon";
import styles from "./layout.module.css";

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

// A pill tab in the top bar (the main areas).
export function TopTab({ href, children }: { href: string; children: React.ReactNode }) {
  const active = isActive(usePathname(), href);
  return (
    <Link href={href} className={styles.tab} aria-current={active ? "page" : undefined}>
      {children}
    </Link>
  );
}

// A round icon button in the left rail; the label shows as a tooltip and is
// the accessible name.
export function RailLink({ href, icon, label }: { href: string; icon: IconName; label: string }) {
  const active = isActive(usePathname(), href);
  return (
    <Link href={href} className={styles.railItem} aria-label={label} data-label={label} aria-current={active ? "page" : undefined}>
      <Icon name={icon} />
    </Link>
  );
}
