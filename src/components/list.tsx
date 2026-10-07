// Full-width rows. A row with href is one big tap target with a chevron;
// a row with children shows them (row actions) under the text.
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
  children,
}: {
  href?: string;
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
        <Link href={href} className={`${styles.row} ${styles.link}`}>
          {text}
          <span aria-hidden="true" className={styles.chevron}>
            ›
          </span>
        </Link>
      </li>
    );
  return (
    <li className={`${styles.item} ${styles.row} ${children ? styles.stacked : ""}`}>
      {text}
      {children && <div className={styles.actions}>{children}</div>}
    </li>
  );
}
