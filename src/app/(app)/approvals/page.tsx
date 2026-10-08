import { notFound } from "next/navigation";
import { Hint, Page } from "@/components/form";
import { Table } from "@/components/table";
import { can } from "@/lib/permissions";
import { listPendingApprovals, mayDecide } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";

export default async function Approvals() {
  const { user, companyId, access, timeZone } = await requireMember();
  if (!can(access, "reminders.approve")) notFound();
  const [pending, decider] = await Promise.all([listPendingApprovals(companyId), mayDecide(companyId, { id: user.id, access })]);

  return (
    <Page title="Approvals">
      {!decider && <Hint>Your company has named approvers (Company settings), so these are for them to decide.</Hint>}
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
