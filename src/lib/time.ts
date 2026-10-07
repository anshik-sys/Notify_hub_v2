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
