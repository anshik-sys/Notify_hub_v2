import { notFound } from "next/navigation";
import { Hint, Page } from "@/components/form";
import { Muted, Table } from "@/components/table";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";
import { listUnsubscribed } from "@/lib/unsubscribe";

// PRD 7.1: outside addresses that unsubscribed from this company's reminders.
// Read-only on purpose: only the person can re-subscribe, from the link in any
// email they got (re-adding someone who opted out isn't the company's call).
export default async function Unsubscribed() {
  const { companyId, access, timeZone } = await requireMember();
  if (!can(access, "company.view")) notFound();
  const rows = await listUnsubscribed(companyId);
  return (
    <Page title="Unsubscribed">
      <Hint>
        Outside addresses that chose to stop getting your company’s reminders. They’re left out of every send. Only they can
        subscribe again, from the link in any email they got.
      </Hint>
      <Table
        columns={["Address", "Unsubscribed on"]}
        empty="Nobody has unsubscribed."
        rows={rows.map((r) => ({ key: r.email, cells: [r.email, <Muted key="t">{formatInZone(r.createdAt, timeZone)}</Muted>] }))}
      />
    </Page>
  );
}
