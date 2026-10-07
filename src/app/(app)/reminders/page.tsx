import { notFound } from "next/navigation";
import { LinkButton, Page } from "@/components/form";
import { Badge, Muted, Table } from "@/components/table";
import { can } from "@/lib/permissions";
import { describe } from "@/lib/recurrence";
import { isDelayed, listReminders, statusLabel } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";

export default async function Reminders() {
  const { user, companyId, access } = await requireMember();
  if (!can(access, "reminders.create") && !can(access, "reminders.view_all")) notFound();
  const reminders = await listReminders(companyId, { id: user.id, access });

  return (
    <Page
      title="Reminders"
      actions={can(access, "reminders.create") && <LinkButton href="/reminders/new">New reminder</LinkButton>}
    >
      <Table
        columns={["Title", "Status", "When", "Type", "ID"]}
        empty="No reminders yet."
        rows={reminders.map((r) => {
          const delayed = isDelayed(r);
          return {
            key: r.id,
            href: `/reminders/${r.id}`,
            cells: [
              r.title,
              <Badge key="s" tone={delayed || r.status === "rejected" ? "danger" : "neutral"}>
                {delayed ? "Delayed" : statusLabel(r)}
              </Badge>,
              r.recurrence ? (
                <span key="w">
                  {describe(r.recurrence, r.anchorLocal)}
                  {r.status === "scheduled" && <Muted> · next {formatInZone(r.sendAt, r.timeZone)}</Muted>}
                </span>
              ) : (
                formatInZone(r.sendAt, r.timeZone)
              ),
              r.isTask ? "Task" : "Reminder",
              <Muted key="id">{r.shortId}</Muted>,
            ],
          };
        })}
      />
    </Page>
  );
}
