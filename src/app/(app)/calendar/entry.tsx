import Link from "next/link";
import { Button, Checkbox } from "@/components/form";
import { Icon } from "@/components/icon";
import { CALENDAR_COLORS } from "@/db/schema";
import { time12, toLocalInput } from "@/lib/time";
import type { CalendarEntry } from "@/lib/views";
import { deleteEntryAction, duplicateAction, editFollowingAction, markTaskAction, moveEntryAction, setColorAction } from "../reminders/actions";
import styles from "./entry.module.css";

const STATE = { scheduled: "", pending: "Needs approval", sent: "Sent" } as const;
const day = (d: Date, tz: string) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz });

// A calendar entry and its peek card (PRD 14.2, K1–K3): the entry is a button
// opening a native popover (Esc and clicking outside close it; focus goes back
// to the entry), placed beside it with CSS anchor positioning. The card shows
// only what the server says this viewer may do; every action is a server
// action that checks again. The colour is the viewer's own.
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
  // An event that happened is "Past"; nothing was "sent" (PRD 14.3).
  const stateLabel = e.event && e.state === "sent" ? "Past" : STATE[e.state];
  const label = [e.title, stateLabel].filter(Boolean).join(" · ");
  const ends = e.event && new Date(e.at.getTime() + e.event.minutes * 60_000);
  const sent = e.state === "sent";
  const series = e.repeat !== null; // an upcoming date of a repeating reminder
  const movable = e.canChange && !sent;
  // "This one" / "This and following" need an approved series (spec M10).
  const scopes: readonly Scope[] | null = series ? (e.state === "pending" ? ["all"] : ["one", "following", "all"]) : null;
  const occurs = e.at.toISOString();
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
        // Drag to move (M1, M5): drag.tsx reads these.
        data-drag-id={movable ? e.reminderId : undefined}
        data-drag-at={movable ? occurs : undefined}
        data-drag-local={movable ? toLocalInput(e.at, tz) : undefined}
        data-drag-scopes={movable && scopes ? scopes.join(",") : undefined}
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
          {e.event?.allDay
            ? `${day(e.at, tz)}${e.event.minutes > 1440 ? ` – ${day(new Date(ends!.getTime() - 86_400_000), tz)}` : ""} · All day`
            : ends
              ? `${day(e.at, tz)} · ${time12(e.at, tz)} – ${time12(ends, tz)}`
              : `${day(e.at, tz)} · ${time12(e.at, tz)}`}
          {e.isTask && " · Task"}
          {stateLabel && <span className={styles.badge}>{stateLabel}</span>}
        </p>
        {e.event?.location && <p className={styles.meta}>{e.event.location}</p>}
        {e.repeat && <p className={styles.meta}>{e.repeat}</p>}
        {e.recipients && <p className={styles.meta}>To: {e.recipients}</p>}

        <div className={styles.actions}>
          {e.event?.meetingUrl && (
            <a href={e.event.meetingUrl} target="_blank" rel="noopener noreferrer" className={`${styles.action} ${styles.join}`}>
              Join
            </a>
          )}
          <Link href={`/reminders/${e.reminderId}`} className={styles.action}>
            Open
          </Link>
          {movable && !series && (
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

        {/* Personal, like Google Calendar's: anyone who sees it picks their own colour. */}
        <form action={setColorAction} className={styles.colours}>
          <input type="hidden" name="id" value={e.reminderId} />
          <input type="hidden" name="next" value={next} />
          <div className={styles.swatches} role="group" aria-label="My colour for this reminder">
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
          </div>
          <p className={styles.colourHint}>
            Only you see this colour.
            {e.myColor && (
              <button name="color" value="" className={styles.reset}>
                Reset
              </button>
            )}
          </p>
        </form>

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

        {movable && series && (
          <details className={styles.fold}>
            <summary>Edit…</summary>
            <div className={styles.foldRow}>
              {scopes!.includes("one") && (
                <Link href={`/reminders/${e.reminderId}/edit?occurs=${encodeURIComponent(occurs)}`} className={styles.action}>
                  This one
                </Link>
              )}
              {scopes!.includes("following") && (
                <form action={editFollowingAction}>
                  <input type="hidden" name="id" value={e.reminderId} />
                  <input type="hidden" name="occursAt" value={occurs} />
                  <input type="hidden" name="next" value={next} />
                  <button className={styles.action}>This and following</button>
                </form>
              )}
              <Link href={`/reminders/${e.reminderId}/edit`} className={styles.action}>
                All
              </Link>
            </div>
          </details>
        )}

        {movable && (
          <details className={styles.fold}>
            <summary>Move to…</summary>
            <form action={moveEntryAction} className={styles.foldForm}>
              <input type="hidden" name="id" value={e.reminderId} />
              <input type="hidden" name="occursAt" value={occurs} />
              <input type="hidden" name="next" value={next} />
              <label className={styles.field}>
                New date and time
                <input type="datetime-local" name="at" defaultValue={toLocalInput(e.at, tz)} required className={styles.input} />
              </label>
              {scopes ? <ScopeChoice scopes={scopes} /> : <input type="hidden" name="scope" value="one" />}
              <Button size="small">Move</Button>
            </form>
          </details>
        )}

        {movable && (
          <details className={styles.fold}>
            <summary>Delete…</summary>
            <form action={deleteEntryAction} className={styles.foldForm}>
              <input type="hidden" name="id" value={e.reminderId} />
              <input type="hidden" name="occursAt" value={occurs} />
              <input type="hidden" name="next" value={next} />
              {scopes ? <ScopeChoice scopes={scopes} /> : <input type="hidden" name="scope" value="all" />}
              <Checkbox label={series ? "Yes, delete what I picked" : "Delete it for everyone"} name="confirm" required />
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

type Scope = "one" | "following" | "all";
const SCOPE_LABEL = { one: "This one", following: "This and following", all: "All" } as const;

// PRD 14.2's choice for a repeating entry (M5, M11, M12); the first is preselected.
function ScopeChoice({ scopes }: { scopes: readonly Scope[] }) {
  return (
    <fieldset className={styles.scopes}>
      <legend className={styles.scopesLegend}>Which dates</legend>
      {scopes.map((sc, i) => (
        <label key={sc} className={styles.scope}>
          <input type="radio" name="scope" value={sc} defaultChecked={i === 0} />
          {SCOPE_LABEL[sc]}
        </label>
      ))}
    </fieldset>
  );
}
