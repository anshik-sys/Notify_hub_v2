import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { Icon } from "@/components/icon";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { unreadCount } from "@/lib/notifications";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { signOutAction } from "./settings/account-actions";
import styles from "./layout.module.css";
import { NavLink } from "./nav-link";

// Signed-in app shell, desktop-first: a rounded frame on a soft canvas with a
// top bar (company, search, theme, notifications, invite), a left sidebar of
// grouped navigation, and the page in a tinted panel. Below 768px the frame
// goes edge to edge and the sidebar becomes a scrollable row.
// Links are hidden by permission for tidiness only; every page checks again.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // true: the shell renders on the security page too (where 2FA is set up);
  // every page enforces the require-2FA gate with its own requireMember().
  const { user, companyId, company, access } = await requireMember(true);
  // Fresh on every navigation; no polling (add it if people ask).
  const unread = await unreadCount(companyId, user.id);
  const seesReminders = can(access, "reminders.create") || can(access, "reminders.view_all");

  return (
    <div className={styles.shell}>
      <div className={styles.frame}>
        <header className={styles.topbar}>
          <Link href="/" className={styles.brand}>
            <span className={styles.logo} aria-hidden="true">
              N
            </span>
            <span className={styles.brandText}>
              <span className={styles.company}>{company.name}</span>
              <span className={styles.product}>NotifyHub</span>
            </span>
          </Link>

          {seesReminders && (
            <form action="/reminders" role="search" className={styles.search}>
              <Icon name="search" />
              <input name="q" type="search" placeholder="Search reminders…" aria-label="Search reminders" className={styles.searchInput} />
            </form>
          )}

          <div className={styles.tools}>
            <ThemeSwitcher compact />
            <Link
              href="/notifications"
              className={styles.round}
              aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
              title="Notifications"
            >
              <Icon name="bell" />
              {!!unread && <span className={styles.dot} aria-hidden="true" />}
            </Link>
            <Link href="/settings/profile" className={styles.me} aria-label="Your profile" title={user.name}>
              <Avatar name={user.name} size="large" />
            </Link>
            {can(access, "users.create") && (
              <Link href="/users/invite" className={styles.invite}>
                <Icon name="plus" />
                <span className={styles.inviteLabel}>Invite</span>
              </Link>
            )}
          </div>
        </header>

        <aside className={styles.sidebar}>
          <nav className={styles.nav} aria-label="Main">
            <p className={styles.navLabel}>Menu</p>
            <NavLink href="/" icon="home">
              Home
            </NavLink>
            <NavLink href="/notifications" icon="notifications" count={unread}>
              Notifications
            </NavLink>
            <NavLink href="/tasks" icon="tasks">
              Tasks
            </NavLink>
            {seesReminders && (
              <>
                <NavLink href="/reminders" icon="reminders">
                  Reminders
                </NavLink>
                <NavLink href="/calendar" icon="calendar">
                  Calendar
                </NavLink>
              </>
            )}
            {can(access, "reminders.approve") && (
              <NavLink href="/approvals" icon="approvals">
                Approvals
              </NavLink>
            )}
            {can(access, "reports.view") && (
              <NavLink href="/reports" icon="reports">
                Reports
              </NavLink>
            )}

            <p className={styles.navLabel}>Workspace</p>
            {can(access, "users.view") && (
              <>
                <NavLink href="/users" icon="people">
                  Team
                </NavLink>
                <NavLink href="/groups" icon="groups">
                  Groups
                </NavLink>
              </>
            )}
            {can(access, "departments.view") && (
              <NavLink href="/departments" icon="departments">
                Departments
              </NavLink>
            )}
            {can(access, "roles.manage") && (
              <NavLink href="/settings/roles" icon="roles">
                Roles
              </NavLink>
            )}
            {can(access, "company.manage_integrations") && (
              <NavLink href="/settings/integrations" icon="integrations">
                Integrations
              </NavLink>
            )}
            {can(access, "audit.view") && (
              <NavLink href="/settings/audit" icon="audit">
                Audit log
              </NavLink>
            )}
            {can(access, "company.edit") && (
              <NavLink href="/settings/company" icon="company">
                Company
              </NavLink>
            )}
            <NavLink href="/settings/profile" icon="settings">
              Settings
            </NavLink>
          </nav>

          <div className={styles.user}>
            <Avatar name={user.name} size="large" />
            <span className={styles.userText}>
              <span className={styles.userName}>{user.name}</span>
              <span className={styles.userEmail}>{user.email}</span>
            </span>
            <form action={signOutAction}>
              <button className={styles.round} aria-label="Sign out" title="Sign out">
                <Icon name="logout" />
              </button>
            </form>
          </div>
        </aside>

        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
