import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, Checkbox, firstParam, LinkButton, Page } from "@/components/form";
import { Tabs } from "@/components/tabs";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { toLocalInput } from "@/lib/time";
import { listUsers } from "@/lib/users";
import { isUserId } from "@/lib/validate";
import {
  addDays,
  CALENDAR_LIMIT,
  type CalendarEntry,
  calendarRange,
  calendarView,
  type Layer,
  LAYERS,
  parseFilters,
  searchReminders,
  shownOn,
  VIEWS,
  weekStart,
} from "@/lib/views";
import { ScrollTo } from "./scroll-to";
import styles from "./page.module.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PER_DAY = 3;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const ALL_LAYERS = Object.keys(LAYERS) as Layer[];
const STATE_LABEL = { scheduled: "", pending: "Needs approval", sent: "Sent" } as const;

// PRD 14.1: Month, Week, Day and N-day views of what the viewer can open, in
// their time zone. Everything is in the URL (GET forms and links, no client
// state), so reload, back and deep links work.
export default async function Calendar(props: PageProps<"/calendar">) {
  const { user, companyId, access, timeZone: tz } = await requireMember();
  if (!can(access, "reminders.create") && !can(access, "reminders.view_all")) notFound();
  const sp = await props.searchParams;
  const now = new Date(); // server-rendered per request, so "now" is the request time
  const today = toLocalInput(now, tz).slice(0, 10);
  const v = calendarView({ view: firstParam(sp.view), date: firstParam(sp.date), n: firstParam(sp.n) }, today);

  // Layers: all on unless the layers form was submitted (ls=1).
  const picked = [sp.layer ?? []].flat().filter((l): l is Layer => ALL_LAYERS.includes(l as Layer));
  const layers = new Set<Layer>(firstParam(sp.ls) === "1" ? picked : ALL_LAYERS);
  const people = can(access, "users.view") ? (await listUsers(companyId)).users.filter((u) => !u.deactivatedAt && u.id !== user.id) : [];
  const personParam = firstParam(sp.person) ?? "";
  const person = people.find((p) => isUserId(personParam) && p.id === personParam);
  const q = (firstParam(sp.q) ?? "").slice(0, 100);
  const miniParam = firstParam(sp.mini) ?? "";
  const mini = /^\d{4}-(0[1-9]|1[0-2])$/.test(miniParam) ? miniParam : v.date.slice(0, 7);

  const viewer = { id: user.id, access };
  const [cal, results] = await Promise.all([
    calendarRange(companyId, viewer, tz, { from: v.from, to: v.to, person: person?.id }),
    q ? searchReminders(companyId, viewer, tz, { ...parseFilters({ q }), sort: "send_asc" }) : null,
  ]);
  if (!cal) notFound();

  // A URL for this page with some settings changed; defaults are left out.
  const href = (over: { view?: string; date?: string; mini?: string | null; q?: string | null } = {}) => {
    const u = new URLSearchParams();
    const view = over.view ?? v.view;
    if (view !== "month") u.set("view", view);
    if (view === "days" && v.n !== 4) u.set("n", String(v.n));
    const date = over.date ?? v.date;
    if (date !== today) u.set("date", date);
    if (layers.size !== ALL_LAYERS.length) {
      u.set("ls", "1");
      for (const l of layers) u.append("layer", l);
    }
    if (person) u.set("person", person.id);
    const query = over.q === null ? "" : (over.q ?? q);
    if (query) u.set("q", query);
    const m = over.mini === null ? null : (over.mini ?? (miniParam ? mini : null));
    if (m) u.set("mini", m);
    const s = u.toString();
    return `/calendar${s ? `?${s}` : ""}`;
  };
  const hidden = (skip: string[]) =>
    [
      ["view", v.view],
      ["date", v.date],
      ["n", v.view === "days" ? String(v.n) : ""],
      ["person", person?.id ?? ""],
      ["q", q],
    ]
      .filter(([k, val]) => val && !skip.includes(k))
      .map(([k, val]) => <input key={k} type="hidden" name={k} value={val} />);

  const time = (d: Date) => toLocalInput(d, tz).slice(11, 16);
  const dayEntries = (day: string) => (cal.days.get(day) ?? []).filter((e) => shownOn(e, layers));
  const entry = (e: CalendarEntry) => (
    <Link
      key={`${e.reminderId}-${e.at.getTime()}-${e.state}`}
      href={`/reminders/${e.reminderId}`}
      className={[styles.entry, styles[e.state], e.theirs ? styles.theirs : ""].join(" ")}
      title={[e.title, STATE_LABEL[e.state], e.theirs && person ? `${person.name}’s` : ""].filter(Boolean).join(" · ")}
    >
      <span className={styles.time}>{time(e.at)}</span> {e.isTask && <span className={styles.tag}>Task</span>} {e.title}
      {e.state !== "scheduled" && <span className={styles.hidden}> ({STATE_LABEL[e.state]})</span>}
    </Link>
  );

  const viewTabs = (Object.keys(VIEWS) as (keyof typeof VIEWS)[]).map((k) => ({
    href: href({ view: k }),
    label: k === "days" ? `${v.n} days` : VIEWS[k],
    current: v.view === k,
  }));

  return (
    <Page
      title={v.title}
      actions={
        <>
          <LinkButton href={href({ date: v.prev })} variant="secondary">
            Previous
          </LinkButton>
          <LinkButton href={href({ date: today, mini: null })} variant="secondary">
            Today
          </LinkButton>
          <LinkButton href={href({ date: v.next })} variant="secondary">
            Next
          </LinkButton>
        </>
      }
    >
      <div className={styles.layout}>
        <aside className={styles.side}>
          <MiniMonth month={mini} today={today} selected={v.date} href={href} />

          <form action="/calendar" className={styles.panel}>
            {hidden(["q"])}
            <input type="hidden" name="ls" value="1" />
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>Show</legend>
              {ALL_LAYERS.map((l) => (
                <Checkbox key={l} label={LAYERS[l]} name="layer" value={l} defaultChecked={layers.has(l)} />
              ))}
            </fieldset>
            <Button size="small" variant="secondary">
              Apply
            </Button>
          </form>

          {people.length > 0 && (
            <form action="/calendar" className={styles.panel}>
              {hidden(["person"])}
              {layers.size !== ALL_LAYERS.length && (
                <>
                  <input type="hidden" name="ls" value="1" />
                  {[...layers].map((l) => (
                    <input key={l} type="hidden" name="layer" value={l} />
                  ))}
                </>
              )}
              <label className={styles.label}>
                A colleague’s calendar
                <select name="person" defaultValue={person?.id ?? ""} className={styles.select}>
                  <option value="">Nobody</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button size="small" variant="secondary">
                Show
              </Button>
            </form>
          )}

          <form action="/calendar" role="search" className={styles.panel}>
            {hidden(["q", "date"])}
            <label className={styles.label}>
              Search
              <input name="q" type="search" defaultValue={q} placeholder="Title, tag or person" className={styles.select} />
            </label>
            <Button size="small" variant="secondary">
              Find
            </Button>
          </form>
        </aside>

        <div className={styles.main}>
          <Tabs label="View" tabs={viewTabs} />
          {results && (
            <section className={styles.results} aria-label="Search results">
              <div className={styles.resultsHead}>
                <strong>{results.total ? `${results.total} found for “${q}”` : `Nothing found for “${q}”`}</strong>
                <Link href={href({ q: null })}>Clear</Link>
              </div>
              {results.rows.slice(0, 10).map((r) => {
                const day = toLocalInput(r.sendAt, tz).slice(0, 10);
                return (
                  <Link key={r.id} href={href({ date: day, q: null })} className={styles.result}>
                    <span className={styles.time}>{day}</span> {r.title}
                  </Link>
                );
              })}
            </section>
          )}
          <p className={styles.hint}>
            In {tz}. Faded: already sent. Dashed: waiting for approval.
            {person && ` Outlined: ${person.name}’s.`}
            {cal.truncated && ` Only the first ${CALENDAR_LIMIT} reminders are shown; use Reminders to filter.`}
          </p>

          {v.view === "month" ? (
            <MonthGrid v={v} today={today} href={href} dayEntries={dayEntries} entry={entry} />
          ) : (
            <HourGrid from={v.from} to={v.to} today={today} now={now} tz={tz} href={href} dayEntries={dayEntries} entry={entry} />
          )}
        </div>
      </div>
    </Page>
  );
}

type Href = (over?: { view?: string; date?: string; mini?: string | null; q?: string | null }) => string;
type Grid = { today: string; href: Href; dayEntries: (day: string) => CalendarEntry[]; entry: (e: CalendarEntry) => React.ReactNode };

// Month: one row per week. The week's label opens Week view; a day number opens Day view (C4).
function MonthGrid({ v, today, href, dayEntries, entry }: Grid & { v: { from: string; to: string } }) {
  const weeks: string[] = [];
  for (let d = weekStart(v.from); d < v.to; d = addDays(d, 7)) weeks.push(d);
  return (
    <div className={styles.grid}>
      <div className={styles.weekday} />
      {WEEKDAYS.map((d) => (
        <div key={d} className={styles.weekday}>
          {d}
        </div>
      ))}
      {weeks.map((w) => [
        <Link key={w} href={href({ view: "week", date: w })} className={styles.weekLink} aria-label={`Week of ${w}`}>
          Week
        </Link>,
        ...Array.from({ length: 7 }, (_, i) => {
          const day = addDays(w, i);
          if (day < v.from || day >= v.to) return <div key={day} className={styles.blank} />;
          const list = dayEntries(day);
          return (
            <div key={day} className={day === today ? `${styles.day} ${styles.today}` : styles.day}>
              <Link href={href({ view: "day", date: day })} className={styles.date} aria-label={`Open ${day}`}>
                {Number(day.slice(8))}
              </Link>
              {list.slice(0, PER_DAY).map(entry)}
              {list.length > PER_DAY && (
                <details className={styles.more}>
                  <summary>+{list.length - PER_DAY} more</summary>
                  {list.slice(PER_DAY).map(entry)}
                </details>
              )}
            </div>
          );
        }),
      ])}
    </div>
  );
}

// Week, Day and N days: a column per day, a row per hour; entries sit in their
// hour (several in one hour stack). A line marks now on today.
function HourGrid({ from, to, today, now, tz, href, dayEntries, entry }: Grid & { from: string; to: string; now: Date; tz: string }) {
  const days: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const local = toLocalInput(now, tz);
  const [nowHour, nowMin] = [Number(local.slice(11, 13)), Number(local.slice(14, 16))];
  const hourOf = (e: CalendarEntry) => Number(toLocalInput(e.at, tz).slice(11, 13));
  const showsToday = days.includes(today);
  const cols = { gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <div className={styles.hours} data-scroll>
      {/* Opens at the earliest entry in view, or 07:00 (the hour before now on today), whichever is first. */}
      <ScrollTo id={`h-${Math.min(showsToday ? Math.max(0, nowHour - 1) : 7, ...days.flatMap(dayEntries).map(hourOf))}`} />
      <div className={styles.hoursHead} style={cols} data-sticky="1">
        <div />
        {days.map((d) => (
          <Link key={d} href={href({ view: "day", date: d })} className={d === today ? `${styles.colHead} ${styles.today}` : styles.colHead}>
            <span>{new Date(`${d}T00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}</span>
            <span className={styles.date}>{Number(d.slice(8))}</span>
          </Link>
        ))}
      </div>
      <div className={styles.hoursBody} style={cols}>
        {HOURS.map((h) => [
          <div key={`l${h}`} id={`h-${h}`} className={styles.hourLabel}>
            {String(h).padStart(2, "0")}:00
          </div>,
          ...days.map((d) => (
            <div key={`${d}-${h}`} className={styles.slot}>
              {d === today && h === nowHour && <span className={styles.now} style={{ top: `${(nowMin / 60) * 100}%` }} aria-hidden="true" />}
              {dayEntries(d)
                .filter((e) => hourOf(e) === h)
                .map(entry)}
            </div>
          )),
        ])}
      </div>
    </div>
  );
}

// C5: picks a date for the current view; its own arrows only change ?mini.
function MiniMonth({ month, today, selected, href }: { month: string; today: string; selected: string; href: Href }) {
  const first = `${month}-01`;
  const prev = addDays(first, -1).slice(0, 7);
  const next = addDays(first, 32).slice(0, 7);
  const cells: string[] = [];
  for (let d = weekStart(first); d.slice(0, 7) <= month || cells.length % 7; d = addDays(d, 1)) cells.push(d);
  const name = new Date(`${first}T00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <nav className={styles.mini} aria-label="Pick a date">
      <div className={styles.miniHead}>
        <Link href={href({ mini: prev })} aria-label="Previous month">
          ‹
        </Link>
        <span>{name}</span>
        <Link href={href({ mini: next })} aria-label="Next month">
          ›
        </Link>
      </div>
      <div className={styles.miniGrid}>
        {WEEKDAYS.map((d) => (
          <span key={d} className={styles.miniWeekday}>
            {d[0]}
          </span>
        ))}
        {cells.map((d) => (
          <Link
            key={d}
            href={href({ date: d, mini: null })}
            className={[styles.miniDay, d.slice(0, 7) !== month ? styles.outside : "", d === today ? styles.miniToday : "", d === selected ? styles.miniSelected : ""].join(" ")}
            aria-current={d === selected ? "date" : undefined}
          >
            {Number(d.slice(8))}
          </Link>
        ))}
      </div>
    </nav>
  );
}
