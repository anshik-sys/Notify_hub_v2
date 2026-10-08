import styles from "./chart.module.css";

// A small grouped bar chart, CSS only (no chart library): one group per
// label, one bar per series, scaled to the largest value. Each bar's title
// gives the exact number on hover; the legend names the series.
export type Series = { name: string; color: 1 | 2 | 3 };

export function BarChart({ series, rows, height = 220 }: { series: Series[]; rows: { label: string; values: number[] }[]; height?: number }) {
  const max = Math.max(1, ...rows.flatMap((r) => r.values));
  const ticks = [max, Math.round(max / 2), 0];
  return (
    <figure className={styles.chart}>
      <ul className={styles.legend}>
        {series.map((s) => (
          <li key={s.name}>
            <span className={styles.swatch} data-color={s.color} /> {s.name}
          </li>
        ))}
      </ul>
      <div className={styles.plot} style={{ height }}>
        <div className={styles.axis} aria-hidden="true">
          {ticks.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
        <div className={styles.groups}>
          {rows.map((r) => (
            <div key={r.label} className={styles.group}>
              <div className={styles.bars}>
                {r.values.map((v, i) => (
                  <span
                    key={i}
                    className={styles.bar}
                    data-color={series[i]?.color ?? 1}
                    style={{ height: `${Math.max(v ? 3 : 0, (v / max) * 100)}%` }}
                    title={`${r.label}: ${v} ${series[i]?.name.toLowerCase() ?? ""}`}
                  />
                ))}
              </div>
              <span className={styles.label}>{r.label}</span>
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}
