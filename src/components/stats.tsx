import Link from "next/link";
import styles from "./stats.module.css";

// Dashboard numbers; each card links to the list it counts.
export function StatCards({ items }: { items: { label: string; value: number; href: string; tone?: "danger" }[] }) {
  return (
    <ul className={styles.cards}>
      {items.map((s) => (
        <li key={s.label}>
          <Link href={s.href} className={s.tone === "danger" && s.value > 0 ? `${styles.card} ${styles.danger}` : styles.card}>
            <span className={styles.value}>{s.value}</span>
            <span className={styles.label}>{s.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
