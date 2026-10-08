import { Button, LinkButton, Page } from "@/components/form";
import { Badge, Muted, Table } from "@/components/table";
import { listNotifications } from "@/lib/notifications";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";
import { markAllReadAction } from "./actions";
import styles from "./page.module.css";

export default async function Notifications(props: PageProps<"/notifications">) {
  const { user, companyId, timeZone } = await requireMember();
  const before = (await props.searchParams).before;
  const at = typeof before === "string" ? new Date(before) : undefined;
  const { items, more } = await listNotifications(companyId, user.id, at && !isNaN(at.getTime()) ? at : undefined);
  const unread = items.some((n) => !n.readAt);

  return (
    <Page
      title="Notifications"
      actions={
        <>
          <LinkButton href="/notifications/preferences" variant="secondary">
            Preferences
          </LinkButton>
          {unread && (
            <form action={markAllReadAction}>
              <Button>Mark all read</Button>
            </form>
          )}
        </>
      }
    >
      <Table
        columns={["What", "Reminder", "When", ""]}
        empty="Nothing yet. Reminders, tasks, approvals and comments for you show up here."
        rows={items.map((n) => ({
          key: n.id,
          href: `/notifications/${n.id}`,
          plain: true,
          cells: [
            <span key="t" className={n.readAt ? undefined : styles.unread}>
              {n.text}
            </span>,
            n.reminderTitle ?? <Muted key="r">Deleted</Muted>,
            <Muted key="w">{formatInZone(n.createdAt, timeZone)}</Muted>,
            n.readAt ? "" : <Badge key="u">New</Badge>,
          ],
        }))}
      />
      {more && (
        <p className={styles.more}>
          <LinkButton href={`/notifications?before=${encodeURIComponent(items.at(-1)!.createdAt.toISOString())}`} variant="secondary">
            Show older
          </LinkButton>
        </p>
      )}
    </Page>
  );
}
