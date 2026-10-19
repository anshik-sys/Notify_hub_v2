import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { companies, emailSuppressions, platformAlerts, platformSettings, reminderOccurrences, reminders, reminderTargets } from "@/db/schema";
import { sendMail } from "@/lib/mail";
import { resolveRecipients } from "@/lib/recipients";
import { between } from "@/lib/recurrence";
import { toLocalInput, zonedToUtc } from "@/lib/time";
import { ownerDb } from "./db";

// PRD 9.2 volume alert, hourly: a company that sent more deliveries in the
// last 24 hours than the platform threshold emails every platform owner,
// at most once per company per day (platform_alerts is the claim).
export async function volumeAlerts(send: typeof sendMail = sendMail, onlyCompany?: string) {
  const owners = (process.env.PLATFORM_OWNER_EMAILS ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  const res = (await ownerDb.execute(sql`
    with s as (select daily_volume_alert as limit_ from platform_settings where id = 1 and daily_volume_alert is not null),
    busy as (
      select d.company_id, count(*)::int as n from deliveries d, s
      where d.created_at > now() - interval '24 hours'
        and (${onlyCompany ?? null}::uuid is null or d.company_id = ${onlyCompany ?? null}::uuid)
      group by d.company_id, s.limit_ having count(*) > s.limit_
    ),
    claimed as (
      insert into platform_alerts (company_id, on_date, kind)
      select company_id, current_date, 'sent' from busy
      on conflict do nothing
      returning company_id
    )
    select c.name, c.domain, b.n, (select limit_ from s) as limit_
    from claimed k join busy b on b.company_id = k.company_id join companies c on c.id = k.company_id`)) as unknown as {
    rows: { name: string; domain: string; n: number; limit_: number }[];
  };
  for (const r of res.rows)
    for (const to of owners)
      await send({
        to,
        subject: `Volume alert: ${r.name} sent ${r.n} in 24 hours`,
        text: `${r.name} (${r.domain}) has ${r.n} deliveries in the last 24 hours, over the alert threshold of ${r.limit_}. You'll get at most one alert per company per day.`,
        links: [{ label: "Open the platform console", url: `${process.env.BETTER_AUTH_URL}/platform` }],
      }).catch((e) => console.error("volume alert email failed", e));
  return res.rows.length;
}

const LOOK_AHEAD_DAYS = 7;
// Local date (YYYY-MM-DD) n days after another, by calendar.
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// PRD 6 volume alert, looking ahead: estimates each company's emails for each
// of its next 7 local days (every occurrence of every scheduled email
// reminder, times its recipients as of now) and emails the platform owners
// about days over the threshold, once per company per day (platform_alerts
// kind 'upcoming'). Slack, paused, pending, deleted and skipped don't count.
// ponytail: expands every scheduled reminder in memory each hour; fine for
// hundreds of companies. If it gets slow, cache recipient counts per reminder.
export async function upcomingVolumeAlerts(now = new Date(), onlyCompany?: string, send: typeof sendMail = sendMail) {
  const [setting] = await ownerDb.select({ limit: platformSettings.dailyVolumeAlert }).from(platformSettings).where(eq(platformSettings.id, 1));
  const threshold = setting?.limit;
  if (threshold == null) return 0;
  const owners = (process.env.PLATFORM_OWNER_EMAILS ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  const list = await ownerDb
    .select({ id: companies.id, name: companies.name, domain: companies.domain, timeZone: companies.timeZone })
    .from(companies)
    .where(and(isNull(companies.suspendedAt), onlyCompany ? eq(companies.id, onlyCompany) : undefined));

  let alerted = 0;
  for (const c of list) {
    const today = toLocalInput(now, c.timeZone).slice(0, 10);
    const end = zonedToUtc(`${addDays(today, LOOK_AHEAD_DAYS)}T00:00`, c.timeZone)!;
    // day -> total, and per reminder that day (for the top 3).
    const days = new Map<string, { total: number; by: Map<string, { title: string; n: number }> }>();
    await ownerDb.transaction(async (tx) => {
      const rs = await tx
        .select()
        .from(reminders)
        .where(
          and(
            eq(reminders.companyId, c.id),
            eq(reminders.status, "scheduled"),
            isNull(reminders.deletedAt),
            sql`'email' = any(${reminders.channels})`,
            lt(reminders.sendAt, end),
          ),
        );
      for (const r of rs) {
        const from = r.sendAt > now ? r.sendAt : now;
        let times = r.recurrence ? between(r.recurrence, r.anchorLocal, r.timeZone, from, end) : r.sendAt >= now ? [r.sendAt] : [];
        times = times.filter((t) => t < end);
        if (!times.length) continue;
        const taken = new Set(
          (await tx.select({ at: reminderOccurrences.occursAt }).from(reminderOccurrences).where(eq(reminderOccurrences.reminderId, r.id))).map((o) =>
            o.at.getTime(),
          ),
        );
        times = times.filter((t) => !taken.has(t.getTime()));
        if (!times.length) continue;
        const targets = await tx.select({ kind: reminderTargets.kind, ref: reminderTargets.ref }).from(reminderTargets).where(eq(reminderTargets.reminderId, r.id));
        const { users, external } = await resolveRecipients(tx, c.id, targets);
        const gone = external.length
          ? await tx
              .select({ email: emailSuppressions.email })
              .from(emailSuppressions)
              .where(and(eq(emailSuppressions.companyId, c.id), inArray(emailSuppressions.email, external)))
          : [];
        const perSend = users.length + external.length - gone.length;
        if (!perSend) continue;
        for (const t of times) {
          const day = toLocalInput(t, c.timeZone).slice(0, 10);
          const d = days.get(day) ?? { total: 0, by: new Map() };
          d.total += perSend;
          const one = d.by.get(r.id) ?? { title: r.title, n: 0 };
          one.n += perSend;
          d.by.set(r.id, one);
          days.set(day, d);
        }
      }
    });

    const busy = [...days].filter(([, d]) => d.total > threshold).sort(([a], [b]) => a.localeCompare(b));
    if (!busy.length) continue;
    const claimed = await ownerDb
      .insert(platformAlerts)
      .values(busy.map(([day]) => ({ companyId: c.id, onDate: day, kind: "upcoming" as const })))
      .onConflictDoNothing()
      .returning({ day: platformAlerts.onDate });
    if (!claimed.length) continue;
    alerted += claimed.length;
    const fresh = new Set(claimed.map((x) => x.day));
    const lines = busy
      .filter(([day]) => fresh.has(day))
      .map(([day, d]) => {
        const top = [...d.by.values()].sort((a, b) => b.n - a.n).slice(0, 3);
        return `${day}: about ${d.total} emails\n${top.map((x) => `  - ${x.title}: ${x.n}`).join("\n")}`;
      });
    for (const to of owners)
      await send({
        to,
        subject: `Volume alert: ${c.name} has a busy day coming up`,
        text: `${c.name} (${c.domain}) has days in the next ${LOOK_AHEAD_DAYS} with more scheduled emails than the alert threshold of ${threshold} (${c.timeZone} dates, estimated from today's recipient lists):\n\n${lines.join("\n\n")}\n\nYou get one alert per company per busy day.`,
        links: [{ label: "Open the platform console", url: `${process.env.BETTER_AUTH_URL}/platform` }],
      }).catch((e) => console.error("upcoming volume alert email failed", e));
  }
  return alerted;
}
