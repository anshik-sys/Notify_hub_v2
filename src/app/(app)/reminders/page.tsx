import { notFound } from "next/navigation";
import { Hint, LinkButton, Page } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { can } from "@/lib/permissions";
import { listReminders, STATUS_LABELS } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";

export default async function Reminders() {
  const { user, companyId, company, access } = await requireMember();
  if (!can(access, "reminders.create") && !can(access, "reminders.view_all")) notFound();
  const reminders = await listReminders(companyId, { id: user.id, access });

  return (
    <Page title="Reminders">
      {can(access, "reminders.create") && <LinkButton href="/reminders/new">New reminder</LinkButton>}
      {reminders.length > 0 ? (
        <List>
          {reminders.map((r) => (
            <ListRow
              key={r.id}
              href={`/reminders/${r.id}`}
              title={r.title}
              badge={STATUS_LABELS[r.status]}
              meta={`${formatInZone(r.sendAt, company.timeZone)} · ${r.shortId}`}
            />
          ))}
        </List>
      ) : (
        <Hint>No reminders yet.</Hint>
      )}
    </Page>
  );
}
