import Link from "next/link";
import { Icon, type IconName } from "./icon";
import styles from "./stats.module.css";

// Dashboard numbers (design reference): title and an icon in a pale circle on
// top, the number and a line of explanation below, a round arrow to the list
// it counts. A "danger" card above zero gets a red icon circle.
export type Stat = { label: string; value: number | string; href: string; hint?: string; icon?: IconName; tone?: "danger" };

export function StatCards({ items }: { items: Stat[] }) {
  return (
    <ul className={styles.cards}>
      {items.map((s) => (
        <li key={s.label}>
          <Link href={s.href} className={styles.card} data-alert={s.tone === "danger" && Number(s.value) > 0 ? "" : undefined}>
            <span className={styles.head}>
              <span className={styles.label}>{s.label}</span>
              <span className={styles.icon}>
                <Icon name={s.icon ?? "reports"} />
              </span>
            </span>
            <span className={styles.foot}>
              <span className={styles.numbers}>
                <span className={styles.value}>{s.value}</span>
                {s.hint && <span className={styles.hint}>{s.hint}</span>}
              </span>
              <span className={styles.arrow} aria-hidden="true">
                <Icon name="arrow" size={16} />
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
