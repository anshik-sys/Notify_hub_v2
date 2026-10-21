import { Button, firstParam, LinkButton, Page } from "@/components/form";
import { Pager } from "@/components/filters";
import { Badge, Muted, Table } from "@/components/table";
import { Tabs } from "@/components/tabs";
import { EVENTS_PAGE, myEvents } from "@/lib/events";
import { ANSWER_LABEL } from "@/lib/invite";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { respondAction } from "../reminders/actions";
import styles from "./page.module.css";

// Section 12: events I organise or am invited to. Every member gets this page
// (EP1): it lists only their own events and invitations, which they may open.
export default async function Events(props: PageProps<"/events">) {
  const { user, companyId, access } = await requireMember();
  const sp = await props.searchParams;
  const past = firstParam(sp.show) === "past";
  const page = Math.max(1, Number(firstParam(sp.page)) || 1);
  const here = past ? `/events?show=past${page > 1 ? `&page=${page}` : ""}` : "/events";
  const { rows, total } = await myEvents(companyId, user.id, { past, page, limit: past ? EVENTS_PAGE : 200 });

  return (
    <Page
      title="Events"
      error={firstParam(sp.error)}
      actions={can(access, "reminders.create") && <LinkButton href="/reminders/new?event=1">New event</LinkButton>}
    >
      <Tabs
        label="Show"
        tabs={[
          { href: "/events", label: "Upcoming", current: !past },
          { href: "/events?show=past", label: "Past", current: past },
        ]}
      />
      <Table
        columns={["Event", "When", "Where", "Organiser", "My answer", "Going"]}
        empty={past ? "No past events yet." : "No upcoming events."}
        rows={rows.map((e) => ({
          key: e.id,
          href: `/reminders/${e.id}`,
          cells: [
            <span key="t" className={styles.title}>
              {e.title}
              {e.now && <Badge tone="success">Now</Badge>}
              {e.status === "pending_approval" && <Badge>Needs approval</Badge>}
              {e.status === "rejected" && <Badge tone="danger">Not approved</Badge>}
            </span>,
            e.when,
            e.location ?? <Muted key="w">—</Muted>,
            e.organiser,
            e.organising ? (
              <Muted key="a">Organiser</Muted>
            ) : e.open ? (
              // EP5: answer in the row; respondAction checks they're a guest.
              <form key="a" action={respondAction} className={styles.answers}>
                <input type="hidden" name="id" value={e.id} />
                <input type="hidden" name="next" value={here} />
                {(["yes", "maybe", "no"] as const).map((a) => (
                  <Button key={a} size="small" name="answer" value={a} variant={e.answer === a ? "primary" : "secondary"} aria-pressed={e.answer === a}>
                    {ANSWER_LABEL[a]}
                  </Button>
                ))}
              </form>
            ) : (
              (e.answer && ANSWER_LABEL[e.answer]) ?? <Muted key="a">No answer</Muted>
            ),
            `${e.going.yes} yes · ${e.going.maybe} maybe · ${e.going.no} no`,
          ],
        }))}
      />
      {past && total > EVENTS_PAGE && <Pager page={page} total={total} pageSize={EVENTS_PAGE} href={(p) => `/events?show=past&page=${p}`} />}
    </Page>
  );
}
