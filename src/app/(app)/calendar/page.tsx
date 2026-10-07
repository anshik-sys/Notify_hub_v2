import Link from "next/link";
import { notFound } from "next/navigation";
import { LinkButton, Page, firstParam } from "@/components/form";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { toLocalInput } from "@/lib/time";
import { CALENDAR_LIMIT, type CalendarEntry, calendarMonth } from "@/lib/views";
import styles from "./page.module.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PER_DAY = 3;
// Server-rendered per request, so "now" is the request time.
const todayIn = (tz: string) => toLocalInput(new Date(), tz).slice(0, 10);
const monthName = (month: string) =>
  new Date(`${month}-01T00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

// PRD 8: upcoming occurrences by month, in the company's time zone.
export default async function Calendar(props: PageProps<"/calendar">) {
  const { user, companyId, company, access } = await requireMember();
  if (!can(access, "reminders.create") && !can(access, "reminders.view_all")) notFound();
  const tz = company.timeZone;
  const today = todayIn(tz);
  const month = firstParam((await props.searchParams).month) ?? today.slice(0, 7);
  const cal = await calendarMonth(companyId, { id: user.id, access }, tz, month);
  if (!cal) notFound();

  const [y, m] = month.split("-").map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday first
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  const time = (d: Date) => toLocalInput(d, tz).slice(11, 16);
  const entry = (e: CalendarEntry) => (
    <Link key={`${e.reminderId}-${e.at.getTime()}`} href={`/reminders/${e.reminderId}`} className={styles.entry} title={e.title}>
      <span className={styles.time}>{time(e.at)}</span> {e.title}
    </Link>
  );

  return (
    <Page
      title={monthName(month)}
      actions={
        <>
          <LinkButton href={`/calendar?month=${cal.prev}`} variant="secondary">
            Previous
          </LinkButton>
          <LinkButton href="/calendar" variant="secondary">
            Today
          </LinkButton>
          <LinkButton href={`/calendar?month=${cal.next}`} variant="secondary">
            Next
          </LinkButton>
        </>
      }
    >
      <p className={styles.hint}>
        Scheduled sends in {tz}.
        {cal.truncated && ` Only the first ${CALENDAR_LIMIT} reminders are shown; use Reminders to filter.`}
      </p>
      <div className={styles.grid}>
        {WEEKDAYS.map((d) => (
          <div key={d} className={styles.weekday}>
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          if (!day) return <div key={`x${i}`} className={styles.blank} />;
          const entries = cal.days.get(day) ?? [];
          return (
            <div key={day} className={day === today ? `${styles.day} ${styles.today}` : styles.day}>
              <span className={styles.date}>{Number(day.slice(8))}</span>
              {entries.slice(0, PER_DAY).map(entry)}
              {entries.length > PER_DAY && (
                <details className={styles.more}>
                  <summary>+{entries.length - PER_DAY} more</summary>
                  {entries.slice(PER_DAY).map(entry)}
                </details>
              )}
            </div>
          );
        })}
      </div>
    </Page>
  );
}
