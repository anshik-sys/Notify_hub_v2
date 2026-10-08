import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { Icon } from "@/components/icon";
import { unreadCount } from "@/lib/notifications";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import styles from "./layout.module.css";
import { RailLink, TopTab } from "./nav-link";
import { signOutAction } from "./settings/account-actions";

// Signed-in app shell (design reference: top pill tabs + slim left rail).
// Top: the main areas as tabs, then notifications, you, and "+ New reminder".
// Left: people and admin areas as round icon buttons, settings and sign out
// at the bottom. Links are hidden by permission for tidiness only; every page
// checks again.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // true: the shell renders on the security page too (where 2FA is set up);
  // every page enforces the require-2FA gate with its own requireMember().
  const { user, companyId, company, access } = await requireMember(true);
  // Fresh on every navigation; no polling (add it if people ask).
  const unread = await unreadCount(companyId, user.id);
  const seesReminders = can(access, "reminders.create") || can(access, "reminders.view_all");

  return (
    <div className={styles.app}>
      <header className={styles.top}>
        <Link href="/" className={styles.logoPill}>
          <span className={styles.logo} aria-hidden="true">
            N
          </span>
          <span className={styles.brandText}>
            <span className={styles.product}>NotifyHub</span>
            <span className={styles.company}>{company.name}</span>
          </span>
        </Link>

        <nav className={styles.tabs} aria-label="Main">
          {seesReminders && (
            <Link href="/reminders" className={styles.round} aria-label="Search reminders" data-label="Search">
              <Icon name="search" />
            </Link>
          )}
          <TopTab href="/">Dashboard</TopTab>
          {seesReminders && <TopTab href="/reminders">Reminders</TopTab>}
          <TopTab href="/tasks">Tasks</TopTab>
          {seesReminders && <TopTab href="/calendar">Calendar</TopTab>}
          {can(access, "reminders.approve") && <TopTab href="/approvals">Approvals</TopTab>}
          {can(access, "reports.view") && <TopTab href="/reports">Reports</TopTab>}
        </nav>

        <div className={styles.topRight}>
          <Link href="/notifications" className={styles.round} aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} data-label="Notifications">
            <Icon name="bell" />
            {unread > 0 && <span className={styles.dot}>{unread > 99 ? "99+" : unread}</span>}
          </Link>
          <Link href="/settings/profile" className={styles.me} aria-label={`${user.name}: settings`}>
            <Avatar name={user.name} />
          </Link>
          {can(access, "reminders.create") && (
            <Link href="/reminders/new" className={styles.plus} aria-label="New reminder" data-label="New reminder">
              <Icon name="plus" size={20} />
            </Link>
          )}
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.railWrap}>
          <nav className={styles.rail} aria-label="People and admin">
            {can(access, "users.view") && <RailLink href="/users" icon="people" label="Team" />}
            {can(access, "users.view") && <RailLink href="/groups" icon="groups" label="Groups" />}
            {can(access, "departments.view") && <RailLink href="/departments" icon="departments" label="Departments" />}
            {can(access, "roles.manage") && <RailLink href="/settings/roles" icon="roles" label="Roles" />}
            {can(access, "company.manage_integrations") && <RailLink href="/settings/integrations" icon="integrations" label="Integrations" />}
            {can(access, "audit.view") && <RailLink href="/settings/audit" icon="audit" label="Audit log" />}
            {can(access, "company.edit") && <RailLink href="/settings/company" icon="company" label="Company settings" />}
          </nav>
          <nav className={styles.rail} aria-label="You">
            <RailLink href="/settings/profile" icon="settings" label="Settings" />
            <form action={signOutAction}>
              <button className={styles.railItem} aria-label="Sign out" data-label="Sign out">
                <Icon name="logout" />
              </button>
            </form>
          </nav>
        </aside>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
