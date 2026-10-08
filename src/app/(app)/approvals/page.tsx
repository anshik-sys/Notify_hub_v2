import { notFound } from "next/navigation";
import { Page } from "@/components/form";
import { Table } from "@/components/table";
import { can } from "@/lib/permissions";
import { listPendingApprovals } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";

export default async function Approvals() {
  const { companyId, access, timeZone } = await requireMember();
  if (!can(access, "reminders.approve")) notFound();
  const pending = await listPendingApprovals(companyId);

  return (
    <Page title="Approvals">
      <Table
        columns={["Reminder", "From", "Sends"]}
        empty="Nothing waiting for approval."
        rows={pending.map((r) => ({
          key: r.id,
          href: `/reminders/${r.id}`,
          cells: [r.title, r.creatorName, formatInZone(r.sendAt, timeZone)],
        }))}
      />
    </Page>
  );
}
