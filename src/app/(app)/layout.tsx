import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { Icon } from "@/components/icon";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { unreadCount } from "@/lib/notifications";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { signOutAction } from "./settings/account-actions";
import styles from "./layout.module.css";
import { ClosePopoverOnNavigate, NavLink } from "./nav-link";

// Signed-in app shell, desktop-first: a rounded frame on a soft canvas with a
// top bar (company, search, theme, notifications, invite), a left sidebar of
// grouped navigation with the user card at the bottom (it opens the account
// menu), and the page in a tinted panel. Below 768px the frame goes edge to
// edge, the sidebar becomes a scrollable row and the top-bar avatar opens the
// same menu instead.
// Links are hidden by permission for tidiness only; every page checks again.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // true: the shell renders on the security page too (where 2FA is set up);
  // every page enforces the require-2FA gate with its own requireMember().
  const { user, companyId, company, access } = await requireMember(true);
  // Fresh on every navigation; no polling (add it if people ask).
  const unread = await unreadCount(companyId, user.id);
  const seesReminders = can(access, "reminders.create") || can(access, "reminders.view_all");
  // Company-wide setup, used now and then: in the account menu, not the sidebar.
  const companyLinks = (
    [
      { href: "/settings/company", icon: "company", label: "Company settings", allowed: can(access, "company.edit") },
      { href: "/settings/integrations", icon: "integrations", label: "Integrations", allowed: can(access, "company.manage_integrations") },
      { href: "/settings/roles", icon: "roles", label: "Roles", allowed: can(access, "roles.manage") },
      { href: "/settings/audit", icon: "audit", label: "Audit log", allowed: can(access, "audit.view") },
    ] as const
  ).filter((l) => l.allowed);

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
              {!!unread && (
                <span className={styles.badge} aria-hidden="true">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Link>
            <button popoverTarget="account-menu" className={styles.me} aria-label="Account menu" title={user.name}>
              <Avatar name={user.name} size="large" />
            </button>
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
          </nav>

          <button popoverTarget="account-menu" className={styles.user}>
            <Avatar name={user.name} size="large" />
            <span className={styles.userText}>
              <span className={styles.userName}>{user.name}</span>
              <span className={styles.userEmail}>{user.email}</span>
            </span>
            <span className={styles.chevron}>
              <Icon name="chevron" size={16} />
            </span>
          </button>

          {/* Native popover: Esc and clicking outside close it, no JS. */}
          <div id="account-menu" popover="auto" className={styles.menu} aria-label="Account">
            <Link href="/settings/profile" className={styles.menuItem}>
              <Icon name="settings" />
              Profile and settings
            </Link>
            <Link href="/settings/security" className={styles.menuItem}>
              <Icon name="lock" />
              Security
            </Link>
            <Link href="/notifications/preferences" className={styles.menuItem}>
              <Icon name="bell" />
              Notification preferences
            </Link>
            {companyLinks.length > 0 && (
              <>
                <p className={styles.menuLabel}>Company</p>
                {companyLinks.map((l) => (
                  <Link key={l.href} href={l.href} className={styles.menuItem}>
                    <Icon name={l.icon} />
                    {l.label}
                  </Link>
                ))}
              </>
            )}
            <form action={signOutAction} className={styles.menuSignOut}>
              <button className={styles.menuItem}>
                <Icon name="logout" />
                Sign out
              </button>
            </form>
          </div>
          <ClosePopoverOnNavigate id="account-menu" />
        </aside>

        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
