// Repeat rules (PRD 5.5). Pure: no DB. Occurrences are computed on wall-clock
// dates in the reminder's time zone, always from the anchor (occurrence k =
// anchor + k * interval), never from the previous one: that's what stops
// drift (31st -> 30 Apr -> back to 31 May). zonedToUtc handles DST.
import { zonedToUtc } from "./time";

export type Rule = {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number; // 1-99
  weekdays?: number[]; // 0 = Mon .. 6 = Sun; weekly only
  monthly?: { by: "day" } | { by: "weekday"; nth: 1 | 2 | 3 | 4 | -1 };
  end: { type: "never" } | { type: "until"; date: string } | { type: "count"; count: number };
};

type Day = { y: number; m: number; d: number }; // m: 1-12

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekdayOf = ({ y, m, d }: Day) => (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = Mon
const addDays = ({ y, m, d }: Day, n: number): Day => {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const key = ({ y, m, d }: Day) => y * 10000 + m * 100 + d;
const pad = (n: number) => String(n).padStart(2, "0");

function parseAnchor(anchorLocal: string) {
  const [date, time] = anchorLocal.split("T");
  const [y, m, d] = date.split("-").map(Number);
  return { day: { y, m, d }, time };
}

// Nth (1-4) or last (-1) given weekday in a month.
function nthWeekday(y: number, m: number, weekday: number, nth: number) {
  if (nth > 0) {
    const first = 1 + ((weekday - weekdayOf({ y, m, d: 1 }) + 7) % 7);
    return first + 7 * (nth - 1);
  }
  const last = daysInMonth(y, m);
  return last - ((weekdayOf({ y, m, d: last }) - weekday + 7) % 7);
}

// Candidate dates, in order, from the anchor date on.
function* dates(rule: Rule, a: Day): Generator<Day> {
  const step = rule.interval;
  const notBefore = key(a);
  for (let k = 0; ; k++) {
    if (rule.freq === "daily") yield addDays(a, k * step);
    else if (rule.freq === "weekly") {
      const weekStart = addDays(a, -weekdayOf(a) + 7 * k * step);
      for (const wd of [...(rule.weekdays?.length ? rule.weekdays : [weekdayOf(a)])].sort()) {
        const day = addDays(weekStart, wd);
        if (key(day) >= notBefore) yield day;
      }
    } else if (rule.freq === "monthly") {
      const months = a.m - 1 + k * step;
      const y = a.y + Math.floor(months / 12);
      const m = (months % 12) + 1;
      const by = rule.monthly ?? { by: "day" };
      const d = by.by === "day" ? Math.min(a.d, daysInMonth(y, m)) : nthWeekday(y, m, weekdayOf(a), by.nth);
      if (key({ y, m, d }) >= notBefore) yield { y, m, d };
    } else {
      const y = a.y + k * step;
      yield { y, m: a.m, d: Math.min(a.d, daysInMonth(y, a.m)) }; // 29 Feb -> 28 Feb
    }
  }
}

// Every occurrence as a UTC instant, in order, until the rule ends.
export function* occurrences(rule: Rule, anchorLocal: string, tz: string): Generator<Date> {
  const { day, time } = parseAnchor(anchorLocal);
  const until = rule.end.type === "until" ? zonedToUtc(`${rule.end.date}T23:59`, tz)!.getTime() + 59_999 : Infinity;
  let n = 0;
  for (const d of dates(rule, day)) {
    if (d.y > day.y + 200) return; // ponytail: hard stop for a runaway "never"; nobody schedules 200 years out
    const at = zonedToUtc(`${d.y}-${pad(d.m)}-${pad(d.d)}T${time}`, tz)!;
    if (at.getTime() > until) return;
    yield at;
    if (rule.end.type === "count" && ++n >= rule.end.count) return;
  }
}

export function firstAtOrAfter(rule: Rule, anchorLocal: string, tz: string, t: Date) {
  for (const at of occurrences(rule, anchorLocal, tz)) if (at >= t) return at;
  return null;
}

export function nextAfter(rule: Rule, anchorLocal: string, tz: string, t: Date) {
  for (const at of occurrences(rule, anchorLocal, tz)) if (at > t) return at;
  return null;
}

// Occurrences with from <= at <= to (the worker's catch-up window).
export function between(rule: Rule, anchorLocal: string, tz: string, from: Date, to: Date) {
  const out: Date[] = [];
  for (const at of occurrences(rule, anchorLocal, tz)) {
    if (at > to) break;
    if (at >= from) out.push(at);
  }
  return out;
}

// --- Plain-language summary -----------------------------------------------------

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LONG_DAY = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ORDINAL = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", [-1]: "last" } as Record<number, string>;
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const every = (n: number, unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);

export function describe(rule: Rule, anchorLocal: string) {
  const { day } = parseAnchor(anchorLocal);
  const wds = [...(rule.weekdays?.length ? rule.weekdays : [weekdayOf(day)])].sort();
  let s: string;
  if (rule.freq === "daily") s = every(rule.interval, "day");
  else if (rule.freq === "weekly")
    s =
      rule.interval === 1 && wds.join() === "0,1,2,3,4"
        ? "Every weekday"
        : `${every(rule.interval, "week")} on ${list(wds.map((w) => DAY_NAMES[w]))}`;
  else if (rule.freq === "monthly")
    s =
      rule.monthly?.by === "weekday"
        ? `${every(rule.interval, "month")} on the ${ORDINAL[rule.monthly.nth]} ${LONG_DAY[weekdayOf(day)]}`
        : `${every(rule.interval, "month")} on day ${day.d}`;
  else s = `${every(rule.interval, "year")} on ${day.d} ${MONTHS[day.m - 1]}`;

  if (rule.end.type === "until") {
    const [y, m, d] = rule.end.date.split("-").map(Number);
    s += `, until ${d} ${MONTHS[m - 1]} ${y}`;
  } else if (rule.end.type === "count") s += `, ${rule.end.count} ${rule.end.count === 1 ? "time" : "times"}`;
  return s;
}

// --- From the form ---------------------------------------------------------------

export type RepeatFields = {
  repeat: string; // none | daily | weekdays | weekly | monthly | yearly | custom
  every: string;
  unit: string; // day | week | month | year
  weekdays: string[];
  monthlyBy: string; // day | weekday | last
  ends: string; // never | until | count
  until: string;
  count: string;
};

const UNIT_FREQ = { day: "daily", week: "weekly", month: "monthly", year: "yearly" } as const;

export function ruleFromForm(f: RepeatFields, anchorLocal: string): { rule: Rule | null } | { error: string } {
  const { day } = parseAnchor(anchorLocal);
  const never = { type: "never" } as const;
  switch (f.repeat) {
    case "none":
    case "":
      return { rule: null };
    case "daily":
      return { rule: { freq: "daily", interval: 1, end: never } };
    case "weekdays":
      return { rule: { freq: "weekly", interval: 1, weekdays: [0, 1, 2, 3, 4], end: never } };
    case "weekly":
      return { rule: { freq: "weekly", interval: 1, weekdays: [weekdayOf(day)], end: never } };
    case "monthly":
      return { rule: { freq: "monthly", interval: 1, monthly: { by: "day" }, end: never } };
    case "yearly":
      return { rule: { freq: "yearly", interval: 1, end: never } };
    case "custom":
      break;
    default:
      return { error: "Choose how often it repeats." };
  }

  const interval = Number(f.every);
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) return { error: "Repeat every 1–99." };
  const freq = UNIT_FREQ[f.unit as keyof typeof UNIT_FREQ];
  if (!freq) return { error: "Choose days, weeks, months or years." };
  const rule: Rule = { freq, interval, end: never };

  if (freq === "weekly") {
    const wds = [...new Set(f.weekdays.map(Number))].filter((w) => Number.isInteger(w) && w >= 0 && w <= 6);
    if (!wds.length) return { error: "Pick at least one day of the week." };
    rule.weekdays = wds.sort();
  }
  if (freq === "monthly") {
    if (f.monthlyBy === "last") rule.monthly = { by: "weekday", nth: -1 };
    else if (f.monthlyBy === "weekday") {
      const nth = Math.ceil(day.d / 7);
      rule.monthly = { by: "weekday", nth: nth >= 5 ? -1 : (nth as 1 | 2 | 3 | 4) };
    } else rule.monthly = { by: "day" };
  }

  if (f.ends === "until") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.until)) return { error: "Pick the date it ends." };
    if (f.until < anchorLocal.slice(0, 10)) return { error: "The end date is before the start." };
    rule.end = { type: "until", date: f.until };
  } else if (f.ends === "count") {
    const count = Number(f.count);
    if (!Number.isInteger(count) || count < 1 || count > 500) return { error: "Repeat 1–500 times." };
    rule.end = { type: "count", count };
  }
  return { rule };
}

// For the custom form's monthly option label: "3rd Tuesday" / "last Friday".
export function anchorWeekdayLabel(anchorLocal: string) {
  const { day } = parseAnchor(anchorLocal);
  const nth = Math.ceil(day.d / 7);
  return `${ORDINAL[nth >= 5 ? -1 : nth]} ${LONG_DAY[weekdayOf(day)]}`;
}

// The reverse of ruleFromForm, for the edit page: presets come back as presets.
export function fieldsFromRule(rule: Rule | null, anchorLocal: string): RepeatFields {
  const base: RepeatFields = { repeat: "none", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" };
  if (!rule) return base;
  const never = rule.end.type === "never";
  const wds = (rule.weekdays ?? []).join();
  const one = rule.interval === 1 && never;
  if (one && rule.freq === "daily") return { ...base, repeat: "daily" };
  if (one && rule.freq === "weekly" && wds === "0,1,2,3,4") return { ...base, repeat: "weekdays" };
  if (one && rule.freq === "weekly" && wds === String(weekdayOf(parseAnchor(anchorLocal).day))) return { ...base, repeat: "weekly" };
  if (one && rule.freq === "monthly" && rule.monthly?.by !== "weekday") return { ...base, repeat: "monthly" };
  if (one && rule.freq === "yearly") return { ...base, repeat: "yearly" };
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.freq];
  return {
    repeat: "custom",
    every: String(rule.interval),
    unit,
    weekdays: (rule.weekdays ?? []).map(String),
    monthlyBy: rule.monthly?.by === "weekday" ? (rule.monthly.nth === -1 ? "last" : "weekday") : "day",
    ends: rule.end.type,
    until: rule.end.type === "until" ? rule.end.date : "",
    count: rule.end.type === "count" ? String(rule.end.count) : "",
  };
}
