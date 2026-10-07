// Short lists (Home sections, links, recipients). A row with href is one
// clickable row with a chevron; a row with children shows them under the text.
// Data lists with columns use Table (table.tsx) instead.
import Link from "next/link";
import styles from "./list.module.css";

export function List({ children }: { children: React.ReactNode }) {
  return <ul className={styles.list}>{children}</ul>;
}

export function ListRow({
  href,
  title,
  meta,
  badge,
  plain,
  children,
}: {
  href?: string;
  /** A full page load with no prefetch, for links that change something when opened. */
  plain?: boolean;
  title: React.ReactNode;
  meta?: React.ReactNode;
  badge?: string;
  children?: React.ReactNode;
}) {
  const text = (
    <div className={styles.text}>
      <span className={styles.title}>
        {title}
        {badge && <span className={styles.badge}>{badge}</span>}
      </span>
      {meta && <span className={styles.meta}>{meta}</span>}
    </div>
  );
  if (href)
    return (
      <li className={styles.item}>
        {plain ? (
          <a href={href} className={`${styles.row} ${styles.link}`}>
            {text}
            <span aria-hidden="true" className={styles.chevron}>
              ›
            </span>
          </a>
        ) : (
          <Link href={href} className={`${styles.row} ${styles.link}`}>
            {text}
            <span aria-hidden="true" className={styles.chevron}>
              ›
            </span>
          </Link>
        )}
      </li>
    );
  return (
    <li className={`${styles.item} ${styles.row} ${children ? styles.stacked : ""}`}>
      {text}
      {children && <div className={styles.actions}>{children}</div>}
    </li>
  );
}
