// Data tables for the desktop list pages. A row with href links its first
// cell (the name), which is the keyboard/screen-reader target; the whole row
// highlights on hover.
import Link from "next/link";
import styles from "./table.module.css";

// plain: a full page load with no prefetch, for links to routes that change
// something when opened (e.g. marking a notification read).
export type TableRow = { key: string; href?: string; plain?: boolean; cells: React.ReactNode[] };

export function Table({ columns, rows, empty }: { columns: string[]; rows: TableRow[]; empty?: string }) {
  if (rows.length === 0 && empty) return <p className={styles.empty}>{empty}</p>;
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} scope="col" className={styles.th}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.href ? `${styles.tr} ${styles.linked}` : styles.tr}>
              {r.cells.map((cell, i) => (
                <td key={i} className={i === 0 ? `${styles.td} ${styles.first}` : styles.td}>
                  {i === 0 && r.href && r.plain ? (
                    <a href={r.href} className={styles.link}>
                      {cell}
                    </a>
                  ) : i === 0 && r.href ? (
                    <Link href={r.href} className={styles.link}>
                      {cell}
                    </Link>
                  ) : (
                    cell
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "danger" | "success"; children: React.ReactNode }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <span className={styles.muted}>{children}</span>;
}

// A horizontal bar for a number in a table cell (reports); no chart library.
export function Bar({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <span className={styles.barWrap} title={label}>
      <span className={styles.bar} style={{ width: `${pct}%` }} />
    </span>
  );
}
