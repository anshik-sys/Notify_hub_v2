import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/db";
import { REMINDER_STATUSES, reminderOccurrences, reminderShares, reminders, user, type ReminderStatus } from "@/db/schema";
import { type Access, can } from "./permissions";
import { between, type Rule } from "./recurrence";
import { sharedWithSql } from "./reminders";
import { toLocalInput, zonedToUtc } from "./time";

// The list screens (PRD 8): All reminders, the dashboard, the calendar.
// Two visibility rules, each the SQL twin of one in src/lib/reminders.ts:
// - overseeWhere = canSeeReminder: yours, all for view_all/approve, and your
//   managed departments' (full access). Dashboard counts use this.
// - canViewWhere = reminderAccess: that, plus shared with you or sent to you.
//   Lists, search and the calendar use this: what you can open, you can find.
//   "Sent to you" includes a manager told someone is late on it (escalation).
// Both leave out deleted reminders, like getReminder.

type Viewer = { id: string; access: Access };

const live = isNull(reminders.deletedAt);
const seesAll = (viewer: Viewer) => can(viewer.access, "reminders.view_all") || can(viewer.access, "reminders.approve");
const mineOrManaged = (viewer: Viewer) =>
  or(
    eq(reminders.createdBy, viewer.id),
    sql`exists (select 1 from department_members m join department_members c on c.department_id = m.department_id
      where m.user_id = ${viewer.id} and m.is_manager and c.user_id = ${reminders.createdBy})`,
  );

export function overseeWhere(viewer: Viewer): SQL | undefined {
  return seesAll(viewer) ? live : and(live, mineOrManaged(viewer));
}

const sharedWithMe = (viewer: Viewer) =>
  sql`exists (select 1 from ${reminderShares} where ${reminderShares.reminderId} = ${reminders.id} and ${sharedWithSql(viewer.id)})`;
const sentToMe = (viewer: Viewer) =>
  sql`exists (select 1 from deliveries d where d.reminder_id = ${reminders.id} and d.user_id = ${viewer.id})`;
const escalatedToMe = (viewer: Viewer) =>
  sql`exists (select 1 from notifications n where n.reminder_id = ${reminders.id} and n.user_id = ${viewer.id} and n.kind = 'escalated')`;

export function canViewWhere(viewer: Viewer): SQL | undefined {
  return seesAll(viewer) ? live : and(live, or(mineOrManaged(viewer), sharedWithMe(viewer), sentToMe(viewer), escalatedToMe(viewer)));
}

// --- All reminders: filters live in the URL ----------------------------------

const REPEATS = ["none", "daily", "weekly", "monthly", "yearly"] as const;
export const SORTS = {
  send_desc: "Send time, latest first",
  send_asc: "Send time, soonest first",
  created_desc: "Newest",
  created_asc: "Oldest",
  title_asc: "Title, A–Z",
  title_desc: "Title, Z–A",
} as const;
export const PAGE_SIZE = 25;
// all: everything you can see; oversee: yours and your teams' (what the
// dashboard counts); mine; shared: shared with you; received: sent to you.
export const SHOWS = ["all", "oversee", "mine", "shared", "received"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUIDISH = /^[\w-]{1,64}$/;

export type Filters = {
  q: string;
  status?: ReminderStatus;
  channel?: "email" | "slack";
  repeat?: (typeof REPEATS)[number];
  creator?: string;
  type?: "task" | "reminder";
  from?: string; // YYYY-MM-DD, company time zone, inclusive
  to?: string;
  tag?: string;
  failed: boolean;
  show: (typeof SHOWS)[number];
  sort: keyof typeof SORTS;
  page: number;
};

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
const pick = <T extends string>(v: string, allowed: readonly T[]) => (allowed.includes(v as T) ? (v as T) : undefined);

// Anything unknown or malformed is dropped, never an error.
export function parseFilters(p: Params): Filters {
  const page = Number(one(p.page));
  return {
    q: one(p.q).slice(0, 100),
    status: pick(one(p.status), REMINDER_STATUSES),
    channel: pick(one(p.channel), ["email", "slack"] as const),
    repeat: pick(one(p.repeat), REPEATS),
    creator: UUIDISH.test(one(p.creator)) ? one(p.creator) : undefined,
    type: pick(one(p.type), ["task", "reminder"] as const),
    from: DATE.test(one(p.from)) ? one(p.from) : undefined,
    to: DATE.test(one(p.to)) ? one(p.to) : undefined,
    tag: one(p.tag).toLowerCase().slice(0, 30) || undefined,
    failed: one(p.failed) === "1",
    show: pick(one(p.show), SHOWS) ?? "all",
    sort: pick(one(p.sort), Object.keys(SORTS) as (keyof typeof SORTS)[]) ?? "send_desc",
    page: Number.isInteger(page) && page > 0 && page < 10_000 ? page : 1,
  };
}

// The URL for these filters with some changed (pager links, stat cards).
export function filterUrl(f: Partial<Filters>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === "" || v === false) continue;
    if ((k === "sort" && v === "send_desc") || (k === "page" && v === 1) || (k === "show" && v === "all")) continue;
    p.set(k, v === true ? "1" : String(v));
  }
  const s = p.toString();
  return s ? `/reminders?${s}` : "/reminders";
}

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const recentFailure = sql`exists (select 1 from deliveries d where d.reminder_id = ${reminders.id}
  and d.status = 'failed' and d.updated_at > now() - interval '30 days')`;

// ponytail: ilike + offset paging is fine to a few thousand reminders per
// company; move to pg_trgm and keyset paging if search gets slow.
export async function searchReminders(companyId: string, viewer: Viewer, timeZone: string, f: Filters) {
  const where: (SQL | undefined)[] = [canViewWhere(viewer)];
  if (f.show === "oversee") where.push(overseeWhere(viewer));
  if (f.show === "mine") where.push(eq(reminders.createdBy, viewer.id));
  if (f.show === "shared") where.push(sharedWithMe(viewer), sql`${reminders.createdBy} <> ${viewer.id}`);
  if (f.show === "received") where.push(sentToMe(viewer));
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(
      or(
        sql`${reminders.title} ilike ${like}`,
        sql`${reminders.description} ilike ${like}`,
        sql`${reminders.shortId} ilike ${like}`,
        sql`exists (select 1 from unnest(${reminders.tags}) tg where tg ilike ${like})`,
        // Recipients: typed emails and channel names; people, departments and groups by name.
        sql`exists (select 1 from reminder_targets t
          left join "user" u on t.kind = 'user' and u.id = t.ref
          left join departments dp on t.kind = 'department' and dp.id::text = t.ref
          left join groups g on t.kind = 'group' and g.id::text = t.ref
          where t.reminder_id = ${reminders.id}
            and (t.ref ilike ${like} or t.label ilike ${like} or u.name ilike ${like} or u.email ilike ${like}
              or dp.name ilike ${like} or g.name ilike ${like}))`,
        sql`exists (select 1 from "user" cu where cu.id = ${reminders.createdBy} and cu.name ilike ${like})`,
      ),
    );
  }
  if (f.status) where.push(eq(reminders.status, f.status));
  if (f.channel) where.push(sql`${f.channel} = any(${reminders.channels})`);
  if (f.repeat === "none") where.push(sql`${reminders.recurrence} is null`);
  else if (f.repeat) where.push(sql`${reminders.recurrence}->>'freq' = ${f.repeat}`);
  if (f.creator) where.push(eq(reminders.createdBy, f.creator));
  if (f.type) where.push(eq(reminders.isTask, f.type === "task"));
  if (f.from) where.push(gte(reminders.sendAt, zonedToUtc(`${f.from}T00:00`, timeZone)!));
  if (f.to) where.push(lt(reminders.sendAt, zonedToUtc(`${nextDay(f.to)}T00:00`, timeZone)!));
  if (f.tag) where.push(sql`${f.tag} = any(${reminders.tags})`);
  if (f.failed) where.push(recentFailure);

  const [col, dir] = f.sort.split("_") as ["send" | "created" | "title", "asc" | "desc"];
  const column = { send: reminders.sendAt, created: reminders.createdAt, title: reminders.title }[col];
  const rows = await withTenant(companyId, (tx) =>
    tx
      .select({
        id: reminders.id,
        shortId: reminders.shortId,
        title: reminders.title,
        status: reminders.status,
        sendAt: reminders.sendAt,
        updatedAt: reminders.updatedAt,
        recurrence: reminders.recurrence,
        anchorLocal: reminders.anchorLocal,
        timeZone: reminders.timeZone,
        isTask: reminders.isTask,
        tags: reminders.tags,
        channels: reminders.channels,
        creatorName: user.name,
        total: sql<number>`count(*) over ()::int`,
      })
      .from(reminders)
      .innerJoin(user, eq(user.id, reminders.createdBy))
      .where(and(...where))
      .orderBy(dir === "asc" ? asc(column) : desc(column), asc(reminders.id))
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
  );
  return { rows, total: rows[0]?.total ?? 0 };
}

// --- Dashboard ---------------------------------------------------------------

// The last day (company time zone) counted as "due in the next 7 days".
export const dueByDate = (timeZone: string, now = new Date()) => toLocalInput(new Date(now.getTime() + 7 * 86_400_000), timeZone).slice(0, 10);

// One query; each number matches the filtered list its card links to.
export async function dashboardStats(companyId: string, viewer: Viewer, timeZone: string, now = new Date()) {
  const dueBy = zonedToUtc(`${nextDay(dueByDate(timeZone, now))}T00:00`, timeZone)!;
  const [row] = await withTenant(companyId, (tx) =>
    tx
      .select({
        pending: sql<number>`count(*) filter (where ${reminders.status} = 'pending_approval')::int`,
        active: sql<number>`count(*) filter (where ${reminders.status} = 'scheduled')::int`,
        dueSoon: sql<number>`count(*) filter (where ${reminders.status} = 'scheduled' and ${reminders.sendAt} < ${dueBy})::int`,
        completed: sql<number>`count(*) filter (where ${reminders.status} = 'sent')::int`,
        failed: sql<number>`count(*) filter (where ${recentFailure})::int`,
      })
      .from(reminders)
      .where(overseeWhere(viewer)),
  );
  return row;
}

export function upcoming(companyId: string, viewer: Viewer, limit = 8) {
  return withTenant(companyId, (tx) =>
    tx
      .select({ id: reminders.id, title: reminders.title, sendAt: reminders.sendAt, recurrence: reminders.recurrence, isTask: reminders.isTask })
      .from(reminders)
      .where(and(eq(reminders.status, "scheduled"), overseeWhere(viewer)))
      .orderBy(asc(reminders.sendAt))
      .limit(limit),
  );
}

// --- Calendar ----------------------------------------------------------------

// PRD 14.1 layers. An entry can be in several; "other" holds what the viewer
// can see that fits none (sent to them directly, or seen through view_all).
export const LAYERS = {
  mine: "Created by me",
  assigned: "Tasks assigned to me",
  departments: "My departments",
  company: "Company-wide",
  other: "Everything else I can see",
} as const;
export type Layer = keyof typeof LAYERS;
export type CalendarEntry = {
  reminderId: string;
  title: string;
  at: Date;
  isTask: boolean;
  // sent: went out (from what was actually sent); pending: waiting for approval.
  state: "scheduled" | "pending" | "sent";
  layers: Layer[];
  // Created by or sent to the colleague being overlaid (C10).
  theirs: boolean;
};
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const CALENDAR_LIMIT = 500;

export function monthBounds(month: string, timeZone: string) {
  const m = MONTH.exec(month);
  if (!m) return null;
  const [y, mo] = [Number(m[1]), Number(m[2])];
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
  return { start: zonedToUtc(`${month}-01T00:00`, timeZone)!, end: zonedToUtc(`${next}-01T00:00`, timeZone)!, next, prev };
}

// The reminder is addressed to this person: directly, through a department or
// group they're in, or the whole company. Targets, not deliveries, so it
// works for sends still to come.
const addressedTo = (userId: string) => sql`exists (select 1 from reminder_targets t where t.reminder_id = ${reminders.id} and (
  t.kind = 'company' or (t.kind = 'user' and t.ref = ${userId})
  or (t.kind = 'department' and t.ref in (select department_id::text from department_members where user_id = ${userId}))
  or (t.kind = 'group' and t.ref in (select group_id::text from group_members where user_id = ${userId}))))`;
const myDepartments = (userId: string) => sql`(select department_id::text from department_members where user_id = ${userId})`;

// Entries between two local dates (from inclusive, to exclusive), keyed by
// local day (YYYY-MM-DD): scheduled and waiting sends (series expanded from
// their rule, recorded occurrences left out) and what was actually sent.
// Only what the viewer can open. With `person`, entries created by or
// addressed to them are flagged `theirs`.
// ponytail: expands up to CALENDAR_LIMIT upcoming reminders per request; page
// by day or cache if a company ever has more.
export async function calendarRange(companyId: string, viewer: Viewer, timeZone: string, range: { from: string; to: string; person?: string }) {
  const start = zonedToUtc(`${range.from}T00:00`, timeZone);
  const end = zonedToUtc(`${range.to}T00:00`, timeZone);
  if (!start || !end || end <= start) return null;
  const flags = {
    mine: sql<boolean>`${reminders.createdBy} = ${viewer.id}`,
    assigned: sql<boolean>`${reminders.isTask} and ${addressedTo(viewer.id)}`,
    departments: sql<boolean>`exists (select 1 from reminder_targets t where t.reminder_id = ${reminders.id} and t.kind = 'department' and t.ref in ${myDepartments(viewer.id)})
      or exists (select 1 from reminder_shares sh where sh.reminder_id = ${reminders.id} and sh.kind = 'department' and sh.ref in ${myDepartments(viewer.id)})`,
    company: sql<boolean>`exists (select 1 from reminder_targets t where t.reminder_id = ${reminders.id} and t.kind = 'company')
      or exists (select 1 from reminder_shares sh where sh.reminder_id = ${reminders.id} and sh.kind = 'company')`,
    theirs: range.person ? sql<boolean>`${reminders.createdBy} = ${range.person} or ${addressedTo(range.person)}` : sql<boolean>`false`,
  };
  const { rows, recorded, sent } = await withTenant(companyId, async (tx) => {
    const rows = await tx
      .select({
        id: reminders.id,
        title: reminders.title,
        status: reminders.status,
        sendAt: reminders.sendAt,
        recurrence: reminders.recurrence,
        anchorLocal: reminders.anchorLocal,
        timeZone: reminders.timeZone,
        isTask: reminders.isTask,
        ...flags,
      })
      .from(reminders)
      .where(
        and(
          inArray(reminders.status, ["scheduled", "pending_approval"]),
          lt(reminders.sendAt, end),
          or(sql`${reminders.recurrence} is not null`, gte(reminders.sendAt, start)),
          canViewWhere(viewer),
        ),
      )
      .orderBy(asc(reminders.sendAt))
      .limit(CALENDAR_LIMIT + 1);
    const series = rows.filter((r) => r.recurrence).map((r) => r.id);
    const recorded = series.length
      ? await tx
          .select({ reminderId: reminderOccurrences.reminderId, at: reminderOccurrences.occursAt })
          .from(reminderOccurrences)
          .where(and(inArray(reminderOccurrences.reminderId, series), gte(reminderOccurrences.occursAt, start), lt(reminderOccurrences.occursAt, end)))
      : [];
    // What went out in the range, as it was sent (the snapshot's title).
    const sent = await tx
      .select({
        id: reminders.id,
        title: sql<string>`coalesce(${reminderOccurrences.snapshot}->>'title', ${reminders.title})`,
        at: reminderOccurrences.occursAt,
        isTask: reminders.isTask,
        ...flags,
      })
      .from(reminderOccurrences)
      .innerJoin(reminders, eq(reminders.id, reminderOccurrences.reminderId))
      .where(
        and(
          inArray(reminderOccurrences.status, ["sent", "sending"]),
          gte(reminderOccurrences.occursAt, start),
          lt(reminderOccurrences.occursAt, end),
          canViewWhere(viewer),
        ),
      )
      .orderBy(asc(reminderOccurrences.occursAt))
      .limit(CALENDAR_LIMIT);
    return { rows, recorded, sent };
  });
  type Flagged = { id: string; title: string; isTask: boolean; mine: boolean; assigned: boolean; departments: boolean; company: boolean; theirs: boolean };
  const base = (r: Flagged) => {
    const layers = (["mine", "assigned", "departments", "company"] as const).filter((l) => r[l]);
    return { reminderId: r.id, title: r.title, isTask: r.isTask, layers: layers.length ? layers : (["other"] as Layer[]), theirs: r.theirs };
  };
  const done = new Set(recorded.map((o) => `${o.reminderId}:${o.at.getTime()}`));
  const days = new Map<string, CalendarEntry[]>();
  const add = (e: CalendarEntry) => {
    const key = toLocalInput(e.at, timeZone).slice(0, 10);
    days.set(key, [...(days.get(key) ?? []), e]);
  };
  for (const r of sent) add({ ...base(r), at: r.at, state: "sent" });
  for (const r of rows.slice(0, CALENDAR_LIMIT)) {
    const entry = { ...base(r), state: r.status === "pending_approval" ? ("pending" as const) : ("scheduled" as const) };
    if (!r.recurrence) {
      add({ ...entry, at: r.sendAt });
      continue;
    }
    const from = r.sendAt > start ? r.sendAt : start;
    for (const at of between(r.recurrence as Rule, r.anchorLocal, r.timeZone, from, new Date(end.getTime() - 1)))
      if (!done.has(`${r.id}:${at.getTime()}`)) add({ ...entry, at });
  }
  for (const list of days.values()) list.sort((x, y) => x.at.getTime() - y.at.getTime());
  return { start, end, days, truncated: rows.length > CALENDAR_LIMIT };
}

// --- Which days a calendar view shows (PRD 14.1), from the URL -----------------

export const VIEWS = { month: "Month", week: "Week", day: "Day", days: "Days" } as const;
export type CalendarView = keyof typeof VIEWS;
const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(new Date(asDate(d).getTime() + n * 86_400_000));
const addMonths = (d: string, n: number) => {
  const x = asDate(`${d.slice(0, 7)}-01`);
  x.setUTCMonth(x.getUTCMonth() + n);
  return iso(x);
};
// Monday of that date's week.
export const weekStart = (d: string) => addDays(d, -((asDate(d).getUTCDay() + 6) % 7));
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => asDate(d).toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });

// view: month | week | day | days (2–7, default 4); date: any day inside it.
// Bad values fall back (to month, today, 4) instead of erroring.
export function calendarView(p: { view?: string; date?: string; n?: string }, today: string) {
  const view: CalendarView = p.view && p.view in VIEWS ? (p.view as CalendarView) : "month";
  const date = p.date && ISO_DAY.test(p.date) && iso(asDate(p.date)) === p.date ? p.date : today;
  const n = Math.min(7, Math.max(2, Number.parseInt(p.n ?? "", 10) || 4));
  const from = view === "month" ? `${date.slice(0, 7)}-01` : view === "week" ? weekStart(date) : date;
  const length = view === "week" ? 7 : view === "day" ? 1 : view === "days" ? n : 0;
  const to = view === "month" ? addMonths(from, 1) : addDays(from, length);
  const step = (dir: 1 | -1) => (view === "month" ? addMonths(from, dir) : addDays(from, dir * (length || 1)));
  const last = addDays(to, -1);
  const title =
    view === "month"
      ? fmt(from, { month: "long", year: "numeric" })
      : view === "day"
        ? fmt(from, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
        : `${fmt(from, { day: "numeric", month: "short", ...(from.slice(0, 4) !== last.slice(0, 4) && { year: "numeric" }) })} – ${fmt(last, { day: "numeric", month: "short", year: "numeric" })}`;
  return { view, date, n, from, to, prev: step(-1), next: step(1), title };
}

// Shown if any of its layers is on (C8), or it's the overlaid colleague's (C10).
export const shownOn = (e: CalendarEntry, on: ReadonlySet<Layer>) => e.theirs || e.layers.some((l) => on.has(l));

// A month (the old view and its tests): scheduled sends only.
export async function calendarMonth(companyId: string, viewer: Viewer, timeZone: string, month: string) {
  const b = monthBounds(month, timeZone);
  if (!b) return null;
  const r = (await calendarRange(companyId, viewer, timeZone, { from: `${month}-01`, to: `${b.next}-01` }))!;
  const days = new Map([...r.days].map(([d, list]) => [d, list.filter((e) => e.state === "scheduled")] as const).filter(([, l]) => l.length));
  return { ...b, days, truncated: r.truncated };
}

// People who created a reminder the viewer can see: the Creator filter's options.
export function visibleCreators(companyId: string, viewer: Viewer) {
  return withTenant(companyId, (tx) =>
    tx
      .selectDistinct({ id: user.id, name: user.name })
      .from(reminders)
      .innerJoin(user, eq(user.id, reminders.createdBy))
      .where(canViewWhere(viewer))
      .orderBy(user.name),
  );
}
