import Link from "next/link";
import { Button, Page, firstParam } from "@/components/form";
import { Badge, Muted, Table } from "@/components/table";
import { requireMember } from "@/lib/session";
import { myDoneTasks, myOpenTasks } from "@/lib/tasks";
import { formatInZone } from "@/lib/time";
import { markTaskAction } from "../reminders/actions";
import styles from "./page.module.css";

// Server-rendered per request, so "now" is the request time.
const isOverdue = (d: Date | null) => Boolean(d && d.getTime() < Date.now());

// PRD 8: formal reminders assigned to me, with done/undo.
export default async function Tasks(props: PageProps<"/tasks">) {
  const { user, companyId } = await requireMember();
  const sp = await props.searchParams;
  const showDone = firstParam(sp.show) === "done";
  const next = showDone ? "/tasks?show=done" : "/tasks";
  const [open, done] = showDone ? [[], await myDoneTasks(companyId, user.id)] : [await myOpenTasks(companyId, user.id, 200), []];

  const toggle = (t: { assignmentId: string; reminderId: string }, done: boolean) => (
    <form key="b" action={markTaskAction}>
      <input type="hidden" name="id" value={t.reminderId} />
      <input type="hidden" name="assignmentId" value={t.assignmentId} />
      <input type="hidden" name="done" value={String(done)} />
      <input type="hidden" name="next" value={next} />
      <Button size="small" variant={done ? "primary" : "secondary"}>
        {done ? "Mark done" : "Undo"}
      </Button>
    </form>
  );

  return (
    <Page title="My tasks" error={firstParam(sp.error)}>
      <nav className={styles.tabs} aria-label="Show">
        <Link href="/tasks" aria-current={showDone ? undefined : "page"}>
          Open
        </Link>
        <Link href="/tasks?show=done" aria-current={showDone ? "page" : undefined}>
          Done
        </Link>
      </nav>
      <Table
        columns={showDone ? ["Task", "Was due", "Done", ""] : ["Task", "Due", ""]}
        empty={showDone ? "Nothing marked done yet." : "No open tasks. Nice."}
        rows={[
          ...open.map((t) => ({
            key: t.assignmentId,
            href: `/reminders/${t.reminderId}`,
            cells: [
              t.title,
              <span key="d" className={styles.due}>
                {t.dueAt ? formatInZone(t.dueAt, t.timeZone) : "—"}
                {isOverdue(t.dueAt) && <Badge tone="danger">Overdue</Badge>}
              </span>,
              toggle(t, true),
            ],
          })),
          ...done.map((t) => ({
            key: t.assignmentId,
            href: `/reminders/${t.reminderId}`,
            cells: [
              t.title,
              <Muted key="d">{t.dueAt ? formatInZone(t.dueAt, t.timeZone) : "—"}</Muted>,
              t.doneAt ? formatInZone(t.doneAt, t.timeZone) : "",
              toggle(t, false),
            ],
          })),
        ]}
      />
    </Page>
  );
}
