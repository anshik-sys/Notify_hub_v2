"use client";

// Client component only to know the current path for the active link.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/icon";
import styles from "./layout.module.css";

export function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: IconName;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  return (
    <Link href={href} className={styles.navItem} aria-current={active ? "page" : undefined}>
      <Icon name={icon} />
      {children}
    </Link>
  );
}
