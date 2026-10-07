// A row of filters that submits with GET, so every filter lives in the URL:
// deep-linkable, and the back button works (PRD 8). No client JS.
import Link from "next/link";
import styles from "./filters.module.css";

export function FilterBar({ action, clearHref, children }: { action: string; clearHref?: string; children: React.ReactNode }) {
  return (
    <form method="get" action={action} className={styles.bar} role="search">
      {children}
      <div className={styles.buttons}>
        <button className={styles.apply}>Apply</button>
        {clearHref && (
          <Link href={clearHref} className={styles.clear}>
            Clear
          </Link>
        )}
      </div>
    </form>
  );
}

// "Page 2 of 7 · Previous · Next"; href builds the link for a page number.
export function Pager({ page, total, pageSize, href }: { page: number; total: number; pageSize: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className={styles.pager} aria-label="Pages">
      <span>
        {total} result{total === 1 ? "" : "s"} · page {Math.min(page, pages)} of {pages}
      </span>
      {page > 1 && <Link href={href(page - 1)}>Previous</Link>}
      {page < pages && <Link href={href(page + 1)}>Next</Link>}
    </nav>
  );
}
