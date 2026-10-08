import Link from "next/link";
import styles from "./tabs.module.css";

// Sub-page switcher (a segmented pill): Open/Done, report kinds.
export function Tabs({ label, tabs }: { label: string; tabs: { href: string; label: string; current: boolean }[] }) {
  return (
    <nav className={styles.tabs} aria-label={label}>
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className={styles.tab} aria-current={t.current ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
