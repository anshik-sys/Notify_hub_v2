import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
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

type Viewer = { id: string; access: Access };

export function overseeWhere(viewer: Viewer): SQL | undefined {
  if (can(viewer.access, "reminders.view_all") || can(viewer.access, "reminders.approve")) return undefined;
  return or(
    eq(reminders.createdBy, viewer.id),
    sql`exists (select 1 from department_members m join department_members c on c.department_id = m.department_id
      where m.user_id = ${viewer.id} and m.is_manager and c.user_id = ${reminders.createdBy})`,
  );
}

const sharedWithMe = (viewer: Viewer) =>
  sql`exists (select 1 from ${reminderShares} where ${reminderShares.reminderId} = ${reminders.id} and ${sharedWithSql(viewer.id)})`;
const sentToMe = (viewer: Viewer) =>
  sql`exists (select 1 from deliveries d where d.reminder_id = ${reminders.id} and d.user_id = ${viewer.id})`;

export function canViewWhere(viewer: Viewer): SQL | undefined {
  const oversee = overseeWhere(viewer);
  return oversee && or(oversee, sharedWithMe(viewer), sentToMe(viewer));
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

export type CalendarEntry = { reminderId: string; title: string; at: Date; isTask: boolean };
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

// Upcoming sends in a month, keyed by local day (YYYY-MM-DD). Series are
// expanded from their rule; occurrences already recorded (skipped) are left out.
// ponytail: expands up to CALENDAR_LIMIT scheduled reminders per request; page
// by day or cache if a company ever has more.
export async function calendarMonth(companyId: string, viewer: Viewer, timeZone: string, month: string) {
  const b = monthBounds(month, timeZone);
  if (!b) return null;
  const { rows, recorded } = await withTenant(companyId, async (tx) => {
    const rows = await tx
      .select({
        id: reminders.id,
        title: reminders.title,
        sendAt: reminders.sendAt,
        recurrence: reminders.recurrence,
        anchorLocal: reminders.anchorLocal,
        timeZone: reminders.timeZone,
        isTask: reminders.isTask,
      })
      .from(reminders)
      .where(
        and(
          eq(reminders.status, "scheduled"),
          lt(reminders.sendAt, b.end),
          or(sql`${reminders.recurrence} is not null`, gte(reminders.sendAt, b.start)),
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
          .where(and(inArray(reminderOccurrences.reminderId, series), gte(reminderOccurrences.occursAt, b.start), lt(reminderOccurrences.occursAt, b.end)))
      : [];
    return { rows, recorded };
  });
  const done = new Set(recorded.map((o) => `${o.reminderId}:${o.at.getTime()}`));
  const days = new Map<string, CalendarEntry[]>();
  const add = (e: CalendarEntry) => {
    const key = toLocalInput(e.at, timeZone).slice(0, 10);
    days.set(key, [...(days.get(key) ?? []), e]);
  };
  for (const r of rows.slice(0, CALENDAR_LIMIT)) {
    const base = { reminderId: r.id, title: r.title, isTask: r.isTask };
    if (!r.recurrence) {
      add({ ...base, at: r.sendAt });
      continue;
    }
    const from = r.sendAt > b.start ? r.sendAt : b.start;
    for (const at of between(r.recurrence as Rule, r.anchorLocal, r.timeZone, from, new Date(b.end.getTime() - 1)))
      if (!done.has(`${r.id}:${at.getTime()}`)) add({ ...base, at });
  }
  for (const list of days.values()) list.sort((x, y) => x.at.getTime() - y.at.getTime());
  return { ...b, days, truncated: rows.length > CALENDAR_LIMIT };
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
