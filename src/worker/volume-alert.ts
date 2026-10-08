import { sql } from "drizzle-orm";
import { sendMail } from "@/lib/mail";
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
      insert into platform_alerts (company_id, on_date)
      select company_id, current_date from busy
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
