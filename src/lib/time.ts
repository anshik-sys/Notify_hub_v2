// Wall-clock time in a named zone <-> UTC, with Intl only (no tz library).

function parts(date: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

// Zone offset from UTC at an instant, in ms.
function offset(ms: number, tz: string) {
  const p = parts(new Date(ms), tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// "2026-10-08T09:00" in tz -> the UTC instant. Like Temporal's "compatible":
// a time skipped by DST moves forward (02:30 -> 03:30), a repeated time
// takes the earlier one. null for malformed input.
export function zonedToUtc(local: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (Number.isNaN(naive)) return null;
  const o1 = offset(naive, tz);
  let t = naive - o1;
  const o2 = offset(t, tz);
  if (o2 !== o1 && offset(naive - o2, tz) === o2) t = naive - o2;
  return new Date(t);
}

// The value for <input type="datetime-local"> showing this instant in tz.
export function toLocalInput(date: Date, tz: string) {
  const p = parts(date, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

export function formatInZone(date: Date, tz: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(date);
}

// Every zone the runtime knows, plus "UTC" (Intl leaves it out). One list for every picker.
export const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

export function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// 12-hour labels for the calendar's hour grid (PRD 14.1): "12 AM", "9 AM", "12 PM".
export const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;

// "9:30 AM" in the zone.
export function time12(date: Date, tz: string) {
  const [h, m] = toLocalInput(date, tz).slice(11, 16).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// "GMT+05:30" for the zone at that moment.
export function offsetLabel(date: Date, tz: string) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value;
  return name ?? "GMT";
}
