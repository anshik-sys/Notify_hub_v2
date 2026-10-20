import Link from "next/link";
import { Button, Checkbox } from "@/components/form";
import { Icon } from "@/components/icon";
import { CALENDAR_COLORS } from "@/db/schema";
import { time12, toLocalInput } from "@/lib/time";
import type { CalendarEntry } from "@/lib/views";
import { deleteReminderAction, duplicateAction, markTaskAction, setColorAction } from "../reminders/actions";
import styles from "./entry.module.css";

const STATE = { scheduled: "", pending: "Needs approval", sent: "Sent" } as const;
const day = (d: Date, tz: string) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz });

// A calendar entry and its peek card (PRD 14.2, K1–K3): the entry is a button
// opening a native popover (Esc and clicking outside close it; focus goes back
// to the entry), placed beside it with CSS anchor positioning. The card shows
// only what the server says this viewer may do; every action is a server
// action that checks again.
export function Entry({
  e,
  n,
  tz,
  now,
  next,
  canCreate,
  className,
  style,
  children,
}: {
  e: CalendarEntry;
  n: number; // unique on the page: popover id and anchor name
  tz: string;
  now: Date; // the request time
  next: string; // this calendar view, to come back to
  canCreate: boolean;
  className: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const id = `peek-${n}`;
  const anchor = `--peek-${n}`;
  const label = [e.title, STATE[e.state]].filter(Boolean).join(" · ");
  const sent = e.state === "sent";
  // Duplicate defaults to the same time a day later (in the future either way).
  const copyAt = toLocalInput(new Date(Math.max(e.at.getTime(), now.getTime()) + 86_400_000), tz);
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        className={`${className} ${styles[e.color]}`}
        style={{ ...style, anchorName: anchor } as React.CSSProperties}
        title={label}
        aria-haspopup="dialog"
      >
        {children}
      </button>
      <div id={id} popover="auto" role="dialog" aria-label={e.title} className={styles.card} style={{ positionAnchor: anchor } as React.CSSProperties}>
        <div className={styles.head}>
          <span className={`${styles.dot} ${styles[e.color]}`} aria-hidden="true" />
          <h3 className={styles.title}>{e.title}</h3>
          <button type="button" popoverTarget={id} popoverTargetAction="hide" className={styles.close} aria-label="Close">
            ×
          </button>
        </div>
        <p className={styles.meta}>
          {day(e.at, tz)} · {time12(e.at, tz)}
          {e.isTask && " · Task"}
          {STATE[e.state] && <span className={styles.badge}>{STATE[e.state]}</span>}
        </p>
        {e.repeat && <p className={styles.meta}>{e.repeat}</p>}
        {e.recipients && <p className={styles.meta}>To: {e.recipients}</p>}

        <div className={styles.actions}>
          <Link href={`/reminders/${e.reminderId}`} className={styles.action}>
            Open
          </Link>
          {e.canChange && !sent && (
            <Link href={`/reminders/${e.reminderId}/edit`} className={styles.action}>
              Edit
            </Link>
          )}
          {e.assignment && (
            <form action={markTaskAction}>
              <input type="hidden" name="id" value={e.reminderId} />
              <input type="hidden" name="assignmentId" value={e.assignment.id} />
              <input type="hidden" name="done" value={String(!e.assignment.done)} />
              <input type="hidden" name="next" value={next} />
              <button className={styles.action}>{e.assignment.done ? "Undo done" : "Mark done"}</button>
            </form>
          )}
        </div>

        {e.canChange && (
          <form action={setColorAction} className={styles.swatches} aria-label="Colour">
            <input type="hidden" name="id" value={e.reminderId} />
            <input type="hidden" name="next" value={next} />
            {CALENDAR_COLORS.map((c) => (
              <button
                key={c}
                name="color"
                value={c}
                className={`${styles.swatch} ${styles[c]}`}
                aria-label={`Colour: ${c}${c === e.color ? " (current)" : ""}`}
                aria-pressed={c === e.color}
                title={c}
              >
                {c === e.color && <Icon name="check" size={14} />}
              </button>
            ))}
          </form>
        )}

        {canCreate && (
          <details className={styles.fold}>
            <summary>Duplicate…</summary>
            <form action={duplicateAction} className={styles.foldForm}>
              <input type="hidden" name="id" value={e.reminderId} />
              <input type="hidden" name="next" value={next} />
              <label className={styles.field}>
                New date and time
                <input type="datetime-local" name="at" defaultValue={copyAt} required className={styles.input} />
              </label>
              <Button size="small">Duplicate</Button>
            </form>
          </details>
        )}

        {/* Repeating ones: deleting one date or the rest comes with the series choices (slice 4). */}
        {e.canChange && !sent && !e.repeat && (
          <details className={styles.fold}>
            <summary>Delete…</summary>
            <form action={deleteReminderAction} className={styles.foldForm}>
              <input type="hidden" name="id" value={e.reminderId} />
              <input type="hidden" name="next" value={next} />
              <Checkbox label="Delete it for everyone" name="confirm" required />
              <Button size="small" variant="danger">
                Delete
              </Button>
            </form>
          </details>
        )}
      </div>
    </>
  );
}
