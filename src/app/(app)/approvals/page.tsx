import { notFound } from "next/navigation";
import { Hint, Page } from "@/components/form";
import { List, ListRow } from "@/components/list";
import { can } from "@/lib/permissions";
import { listPendingApprovals } from "@/lib/reminders";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";

export default async function Approvals() {
  const { companyId, company, access } = await requireMember();
  if (!can(access, "reminders.approve")) notFound();
  const pending = await listPendingApprovals(companyId);

  return (
    <Page title="Approvals" back={{ href: "/", label: "Home" }}>
      {pending.length > 0 ? (
        <List>
          {pending.map((r) => (
            <ListRow
              key={r.id}
              href={`/reminders/${r.id}`}
              title={r.title}
              meta={`${r.creatorName} · ${formatInZone(r.sendAt, company.timeZone)}`}
            />
          ))}
        </List>
      ) : (
        <Hint>Nothing waiting for approval.</Hint>
      )}
    </Page>
  );
}
