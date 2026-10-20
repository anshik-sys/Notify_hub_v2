"use client";

import Link from "next/link";
import { useState } from "react";
import styles from "./month-picker.module.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The page title as a button: opens a year with its 12 months; picking one
// goes to that month in the current view. A native popover (Esc and clicking
// outside close it); the year arrows are the only client state.
// `href` holds __DATE__ where the first of the picked month goes.
export function MonthPicker({ title, month, today, href }: { title: string; month: string; today: string; href: string }) {
  const [year, setYear] = useState(Number(month.slice(0, 4)));
  const close = () => document.getElementById("month-picker")?.hidePopover();
  return (
    <>
      <button popoverTarget="month-picker" className={styles.trigger} aria-haspopup="dialog">
        {title}
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" className={styles.chevron}>
          <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div
        id="month-picker"
        popover="auto"
        role="dialog"
        aria-label="Go to a month"
        className={styles.panel}
        onToggle={(e) => e.newState === "open" && setYear(Number(month.slice(0, 4)))}
      >
        <div className={styles.year}>
          <button type="button" onClick={() => setYear((y) => y - 1)} aria-label="Previous year">
            ‹
          </button>
          <span>{year}</span>
          <button type="button" onClick={() => setYear((y) => y + 1)} aria-label="Next year">
            ›
          </button>
        </div>
        <div className={styles.months}>
          {MONTHS.map((name, i) => {
            const m = `${year}-${String(i + 1).padStart(2, "0")}`;
            const cls = [styles.month, m === month ? styles.current : "", m === today.slice(0, 7) ? styles.now : ""].join(" ");
            return (
              <Link key={m} href={href.replace("__DATE__", `${m}-01`)} className={cls} aria-current={m === month ? "date" : undefined} onClick={close}>
                {name}
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
