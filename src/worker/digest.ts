import { and, asc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { companies, reminderOccurrences, reminders, slackInstallations, taskAssignments, user } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { digestMessage, lookupByEmail, openDm, postMessage } from "@/lib/slack";
import { formatInZone } from "@/lib/time";
import { ownerDb } from "./db";

// Daily Slack digest (PRD 7.2), per company, at its digest time (company zone).
// Same claim pattern as task follow-ups: one UPDATE stamps last_digest_on with
// the company-local date, so a second tick or worker that day matches nothing.

// now and onlyCompany are for tests (move the clock; never stamp other companies).
export async function claimDigests(now = new Date(), onlyCompany?: string) {
  const { rows } = await ownerDb.execute<{ company_id: string }>(sql`
    update slack_installations s
       set last_digest_on = (${now}::timestamptz at time zone c.time_zone)::date
      from companies c
     where c.id = s.company_id and s.digest_enabled and c.suspended_at is null
       and (${onlyCompany ?? null}::uuid is null or s.company_id = ${onlyCompany ?? null}::uuid)
       and ${now}::timestamptz >= (((${now}::timestamptz at time zone c.time_zone)::date + s.digest_time::time) at time zone c.time_zone)
       and (s.last_digest_on is null or s.last_digest_on < (${now}::timestamptz at time zone c.time_zone)::date)
    returning s.company_id`);
  return rows.map((r) => r.company_id);
}

// What's overdue (tasks with someone not done) and what goes out in the next 24h.
export async function digestContent(companyId: string, now = new Date()) {
  const [company] = await ownerDb.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, companyId));
  const tz = company.tz;
  const overdue = await ownerDb
    .select({
      id: reminders.id,
      title: reminders.title,
      dueAt: reminderOccurrences.dueAt,
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${taskAssignments.doneAt} is null)::int`,
    })
    .from(reminderOccurrences)
    .innerJoin(reminders, eq(reminders.id, reminderOccurrences.reminderId))
    .innerJoin(taskAssignments, eq(taskAssignments.occurrenceId, reminderOccurrences.id))
    .where(
      and(
        eq(reminderOccurrences.companyId, companyId),
        lt(reminderOccurrences.dueAt, now),
        eq(reminders.isTask, true),
        ne(reminders.status, "cancelled"),
      ),
    )
    .groupBy(reminders.id, reminders.title, reminderOccurrences.id, reminderOccurrences.dueAt)
    .having(sql`count(*) filter (where ${taskAssignments.doneAt} is null) > 0`)
    .orderBy(asc(reminderOccurrences.dueAt))
    .limit(100);
  const upcoming = await ownerDb
    .select({ id: reminders.id, title: reminders.title, sendAt: reminders.sendAt, isTask: reminders.isTask })
    .from(reminders)
    .where(
      and(
        eq(reminders.companyId, companyId),
        eq(reminders.status, "scheduled"),
        gte(reminders.sendAt, now),
        lt(reminders.sendAt, new Date(now.getTime() + 24 * 3_600_000)),
      ),
    )
    .orderBy(asc(reminders.sendAt))
    .limit(100);
  return {
    date: new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: tz }).format(now),
    overdue: overdue.map((o) => ({
      id: o.id,
      title: o.title,
      detail: `${o.open} of ${o.total} not done · due ${formatInZone(o.dueAt!, tz)}`,
    })),
    upcoming: upcoming.map((u) => ({
      id: u.id,
      title: u.title,
      detail: `${formatInZone(u.sendAt, tz)}${u.isTask ? " · task" : ""}`,
    })),
  };
}

// Posts to each chosen channel and DMs each chosen person. Each destination is
// independent: a failure is logged and the rest still go. No retries (the
// claim already happened; at most one digest a day).
export async function digestOne(companyId: string, f?: typeof fetch, now = new Date()) {
  const [inst] = await ownerDb.select().from(slackInstallations).where(eq(slackInstallations.companyId, companyId));
  if (!inst?.digestEnabled) return { sent: [] as string[], skipped: [] as string[], failed: [] as string[] };
  const token = decrypt(inst.botTokenEnc);
  const msg = digestMessage({ ...(await digestContent(companyId, now)), appUrl: process.env.BETTER_AUTH_URL ?? "" });
  const result = { sent: [] as string[], skipped: [] as string[], failed: [] as string[] };

  const people = inst.digestUserIds.length
    ? await ownerDb
        .select({ id: user.id, email: user.email })
        .from(user)
        .where(and(inArray(user.id, inst.digestUserIds), eq(user.companyId, companyId), isNull(user.deactivatedAt)))
    : [];
  const destinations: { label: string; channel: () => Promise<string | null> }[] = [
    ...inst.digestChannelIds.map((id) => ({ label: id, channel: async () => id })),
    ...people.map((p) => ({
      label: p.email,
      channel: async () => {
        const slackUser = await lookupByEmail(token, p.email, f);
        return slackUser ? openDm(token, slackUser, f) : null;
      },
    })),
  ];
  for (const dest of destinations) {
    try {
      const channel = await dest.channel();
      if (!channel) {
        result.skipped.push(dest.label); // no Slack account
        continue;
      }
      await postMessage(token, channel, msg.text, msg.blocks, f);
      result.sent.push(dest.label);
    } catch (e) {
      console.error("digest destination failed", dest.label, e);
      result.failed.push(dest.label);
    }
  }
  return result;
}
