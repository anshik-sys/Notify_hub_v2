import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, Checkbox, firstParam, LinkButton, Page } from "@/components/form";
import { Icon } from "@/components/icon";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { hourLabel, offsetLabel, time12, toLocalInput } from "@/lib/time";
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
  layoutDay,
  parseFilters,
  searchReminders,
  shownOn,
  VIEWS,
  weekStart,
} from "@/lib/views";
import { AutoSubmit } from "./auto-submit";
import { DragMove } from "./drag";
import { Entry } from "./entry";
import { QUICK_ID, QuickCreate } from "./quick-create";
import { ScrollTo } from "./scroll-to";
import { ViewMenu } from "./view-menu";
import styles from "./page.module.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PER_DAY = 3;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const ALL_LAYERS = Object.keys(LAYERS) as Layer[];
const STATE_LABEL = { scheduled: "", pending: "Needs approval", sent: "Sent" } as const;

// PRD 14.1, laid out like Google Calendar (the user's reference): a toolbar
// (Today, ‹ ›, the date, search, the view menu), a left panel (Create, the
// mini month, a colleague, the layers) and the grid. The app sidebar is an
// icon rail here ([data-rail], layout.module.css). Everything is in the URL
// (links and GET forms), so reload, back and deep links work.
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
  // The current settings as hidden fields, for the GET forms.
  const hidden = (skip: string[]) => {
    const fields: [string, string][] = [
      ["view", v.view],
      ["date", v.date],
      ["n", v.view === "days" ? String(v.n) : ""],
      ["person", person?.id ?? ""],
      ["q", q],
      ...(layers.size !== ALL_LAYERS.length && !skip.includes("layer") ? ([["ls", "1"], ...[...layers].map((l) => ["layer", l])] as [string, string][]) : []),
    ];
    return fields.filter(([k, val]) => val && !skip.includes(k)).map(([k, val], i) => <input key={`${k}-${i}`} type="hidden" name={k} value={val} />);
  };

  const dayEntries = (day: string) => (cal.days.get(day) ?? []).filter((e) => shownOn(e, layers));
  const stateClass = (e: CalendarEntry) => [styles[e.state], e.theirs ? styles.theirs : ""].join(" ");
  const key = (e: CalendarEntry) => `${e.reminderId}-${e.at.getTime()}-${e.state}`;
  // Each entry opens its own peek card; n keeps their ids unique on the page.
  let n = 0;
  const here = href();
  const canCreate = can(access, "reminders.create");

  return (
    <Page
      title={v.title}
      error={firstParam(sp.error)}
      notice={firstParam(sp.notice)}
      actions={
        <div className={styles.toolbar}>
          <LinkButton href={href({ date: today, mini: null })} variant="secondary">
            Today
          </LinkButton>
          <Link href={href({ date: v.prev })} className={styles.round} aria-label="Previous" title="Previous">
            <Icon name="left" />
          </Link>
          <Link href={href({ date: v.next })} className={styles.round} aria-label="Next" title="Next">
            <Icon name="right" />
          </Link>
          <form action="/calendar" role="search" className={styles.search}>
            {hidden(["q", "date"])}
            <Icon name="search" />
            <input name="q" type="search" defaultValue={q} placeholder="Search" aria-label="Search the calendar: title, tag or person" />
          </form>
          <ViewMenu
            label={v.view === "days" ? `${v.n} days` : VIEWS[v.view]}
            items={(["day", "week", "month", "days"] as const).map((k) => ({
              href: href({ view: k }),
              label: k === "days" ? `${v.view === "days" ? v.n : 4} days` : VIEWS[k],
              current: v.view === k,
            }))}
          />
        </div>
      }
    >
      {canCreate && <QuickCreate next={here} />}
      <DragMove next={here} />
      <div className={styles.layout} data-rail>
        <aside className={styles.side}>
          <LinkButton href="/reminders/new">
            <Icon name="plus" /> Create
          </LinkButton>

          <MiniMonth month={mini} today={today} selected={v.date} href={href} />

          {people.length > 0 && (
            <form action="/calendar" className={styles.panel}>
              {hidden(["person"])}
              <AutoSubmit />
              <label className={styles.label}>
                Meet with…
                <select name="person" defaultValue={person?.id ?? ""} className={styles.select}>
                  <option value="">Nobody: just my calendar</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <noscript>
                <Button size="small" variant="secondary">
                  Show
                </Button>
              </noscript>
            </form>
          )}

          <form action="/calendar" className={styles.panel}>
            {hidden(["layer", "q"])}
            <input type="hidden" name="ls" value="1" />
            <AutoSubmit />
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>My calendars</legend>
              {ALL_LAYERS.map((l) => (
                <Checkbox key={l} label={LAYERS[l]} name="layer" value={l} defaultChecked={layers.has(l)} />
              ))}
            </fieldset>
            <noscript>
              <Button size="small" variant="secondary">
                Apply
              </Button>
            </noscript>
          </form>
        </aside>

        <div className={styles.main}>
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
          {(person || cal.truncated) && (
            <p className={styles.hint}>
              {person && `Outlined: ${person.name}’s. `}
              {cal.truncated && `Only the first ${CALENDAR_LIMIT} reminders are shown; use Reminders to filter.`}
            </p>
          )}

          {v.view === "month" ? (
            <MonthGrid
              v={v}
              today={today}
              selected={v.date}
              canCreate={canCreate}
              href={href}
              dayEntries={dayEntries}
              entry={(e) => (
                <Entry key={key(e)} e={e} n={n++} tz={tz} now={now} next={here} canCreate={canCreate} className={`${styles.entry} ${stateClass(e)}`}>
                  <span className={styles.time}>{time12(e.at, tz)}</span> {e.title}
                  {e.state !== "scheduled" && <span className={styles.hidden}> ({STATE_LABEL[e.state]})</span>}
                </Entry>
              )}
            />
          ) : (
            <HourGrid
              from={v.from}
              to={v.to}
              today={today}
              selected={v.date}
              canCreate={canCreate}
              now={now}
              tz={tz}
              href={href}
              dayEntries={dayEntries}
              block={(p) => (
                <Entry
                  key={key(p.entry)}
                  e={p.entry}
                  n={n++}
                  tz={tz}
                  now={now}
                  next={here}
                  canCreate={canCreate}
                  className={`${styles.block} ${stateClass(p.entry)}`}
                  style={{
                    top: `${(p.minute / 1440) * 100}%`,
                    left: `${(p.lane / p.lanes) * 100}%`,
                    width: `calc(${100 / p.lanes}% - 4px)`,
                  }}
                >
                  <span className={styles.blockTitle}>
                    {p.entry.isTask && <span className={styles.tag}>Task</span>} {p.entry.title}
                  </span>
                  <span className={styles.time}>{time12(p.entry.at, tz)}</span>
                  {p.entry.state !== "scheduled" && <span className={styles.hidden}> ({STATE_LABEL[p.entry.state]})</span>}
                </Entry>
              )}
            />
          )}
        </div>
      </div>
    </Page>
  );
}

type Href = (over?: { view?: string; date?: string; mini?: string | null; q?: string | null }) => string;
// selected: the date picked (mini month, search, a day link), marked in the grid too.
type Grid = { today: string; selected: string; canCreate: boolean; href: Href; dayEntries: (day: string) => CalendarEntry[] };
const dayClass = (day: string, today: string, selected: string, base: string) =>
  [base, day === today ? styles.today : "", day === selected ? styles.selected : ""].join(" ");

// Month: one row per week. The arrow at a row's start opens that week; a day number opens Day view (C4).
function MonthGrid({ v, today, selected, canCreate, href, dayEntries, entry }: Grid & { v: { from: string; to: string }; entry: (e: CalendarEntry) => React.ReactNode }) {
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
        <Link key={`week-${w}`} href={href({ view: "week", date: w })} className={styles.weekLink} aria-label={`Week of ${w}`} title="Open this week">
          <Icon name="right" size={14} />
        </Link>,
        ...Array.from({ length: 7 }, (_, i) => {
          const day = addDays(w, i);
          if (day < v.from || day >= v.to) return <div key={day} className={styles.blank} />;
          const list = dayEntries(day);
          return (
            <div key={day} className={dayClass(day, today, selected, styles.day)} aria-current={day === selected ? "date" : undefined}>
              {/* The empty part of the day: quick create at 9 AM (Q1). Mouse only;
                  keyboard users have + Create. */}
              {canCreate && (
                <button type="button" popoverTarget={QUICK_ID} data-quick-at={`${day}T09:00`} className={styles.slot} tabIndex={-1} aria-label={`New on ${day}`} />
              )}
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

// Week, Day and N days: a column per day over 24 hour rows. Entries are
// 30-minute blocks at their exact minute (layoutDay); blocks that overlap sit
// side by side. A line marks now on today.
function HourGrid({
  from,
  to,
  today,
  selected,
  canCreate,
  now,
  tz,
  href,
  dayEntries,
  block,
}: Grid & { from: string; to: string; now: Date; tz: string; block: (p: ReturnType<typeof layoutDay>[number]) => React.ReactNode }) {
  const days: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const local = toLocalInput(now, tz);
  const nowMinute = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
  const placed = new Map(days.map((d) => [d, layoutDay(dayEntries(d), tz)]));
  const first = Math.min(...[...placed.values()].flat().map((p) => Math.floor(p.minute / 60)));
  // Opens at the earliest entry in view, or 7 AM (the hour before now on today), whichever is first.
  const scrollHour = Math.min(days.includes(today) ? Math.max(0, Math.floor(nowMinute / 60) - 1) : 7, first);
  const cols = { gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <div className={styles.hours} data-scroll>
      <ScrollTo id={`h-${scrollHour}`} />
      <div className={styles.hoursHead} style={cols} data-sticky="1">
        <div className={styles.zone}>{offsetLabel(now, tz)}</div>
        {days.map((d) => (
          <Link
            key={d}
            href={href({ view: "day", date: d })}
            className={dayClass(d, today, selected, styles.colHead)}
            aria-current={d === selected ? "date" : undefined}
          >
            <span className={styles.colDay}>{new Date(`${d}T00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}</span>
            <span className={styles.colDate}>{Number(d.slice(8))}</span>
          </Link>
        ))}
      </div>
      <div className={styles.hoursBody} style={cols}>
        <div className={styles.hourLabels}>
          {HOURS.map((h) => (
            <div key={h} id={`h-${h}`} className={styles.hourLabel}>
              {h > 0 && hourLabel(h)}
            </div>
          ))}
        </div>
        {days.map((d) => (
          <div key={d} className={styles.column}>
            {/* Empty hours: quick create there (the lower half picks :30). Mouse only; keyboard users have + Create. */}
            {canCreate &&
              HOURS.map((h) => (
                <button
                  key={h}
                  type="button"
                  popoverTarget={QUICK_ID}
                  data-quick-at={`${d}T${String(h).padStart(2, "0")}:00`}
                  data-half=""
                  className={styles.hourSlot}
                  style={{ top: `${(h / 24) * 100}%` }}
                  tabIndex={-1}
                  aria-label={`New on ${d} at ${hourLabel(h)}`}
                />
              ))}
            {d === today && <span className={styles.now} style={{ top: `${(nowMinute / 1440) * 100}%` }} aria-hidden="true" />}
            {placed.get(d)!.map(block)}
          </div>
        ))}
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
        <span>{name}</span>
        <span className={styles.miniArrows}>
          <Link href={href({ mini: prev })} aria-label="Previous month">
            <Icon name="left" size={16} />
          </Link>
          <Link href={href({ mini: next })} aria-label="Next month">
            <Icon name="right" size={16} />
          </Link>
        </span>
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
