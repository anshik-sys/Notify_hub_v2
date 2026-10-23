import Link from "next/link";
import { Icon, type IconName } from "./icon";
import styles from "./stats.module.css";

type Tone = "danger" | "warning" | "info" | "success";

// Dashboard numbers; a card with an href links to the list it counts (and shows
// the arrow); one without is just the number. tone tints the
// icon by meaning; danger and warning only tint when there's something (> 0),
// so a quiet dashboard stays calm.
export function StatCards({
  items,
}: {
  items: { label: string; value: number; href?: string; tone?: Tone; icon?: IconName }[];
}) {
  return (
    <ul className={styles.cards}>
      {items.map((s) => {
        const tone = s.tone && (s.value > 0 || s.tone === "info" || s.tone === "success") ? s.tone : undefined;
        const className = tone ? `${styles.card} ${styles[tone]}` : styles.card;
        const body = (
          <>
            <span className={styles.head}>
              {s.icon && (
                <span className={styles.icon}>
                  <Icon name={s.icon} size={16} />
                </span>
              )}
              <span className={styles.label}>{s.label}</span>
            </span>
            <span className={styles.value}>{s.value}</span>
          </>
        );
        return (
          <li key={s.label}>
            {s.href ? (
              <Link href={s.href} className={className}>
                {body}
                <span className={styles.arrow}>
                  <Icon name="arrow" size={16} />
                </span>
              </Link>
            ) : (
              <div className={className}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
