import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import styles from "./layout.module.css";
import { NavLink } from "./nav-link";

// Signed-in app shell, desktop-first: a left sidebar with navigation and the
// page beside it. Below 768px the sidebar becomes a top bar.
// Links are hidden by permission for tidiness only; every page checks again.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { company, access } = await requireMember();

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.product}>NotifyHub</span>
          <span className={styles.company}>{company.name}</span>
        </div>
        <nav className={styles.nav} aria-label="Main">
          <NavLink href="/" icon="home">
            Home
          </NavLink>
          {(can(access, "reminders.create") || can(access, "reminders.view_all")) && (
            <NavLink href="/reminders" icon="reminders">
              Reminders
            </NavLink>
          )}
          {can(access, "reminders.approve") && (
            <NavLink href="/approvals" icon="approvals">
              Approvals
            </NavLink>
          )}
          {can(access, "users.view") && (
            <NavLink href="/users" icon="people">
              People
            </NavLink>
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
          {can(access, "company.edit") && (
            <NavLink href="/settings/company" icon="settings">
              Settings
            </NavLink>
          )}
        </nav>
      </aside>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
