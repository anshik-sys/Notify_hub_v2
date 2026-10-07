import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import styles from "./layout.module.css";
import { NavLink } from "./nav-link";

// Signed-in app shell: company name on top, tab bar at the bottom (thumb reach).
// Tabs are hidden by permission for tidiness only; every page checks again.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { company, access } = await requireMember();

  return (
    <div className={styles.shell}>
      <header className={styles.topBar}>
        <span className={styles.company}>{company.name}</span>
      </header>
      <div className={styles.content}>{children}</div>
      <nav className={styles.tabBar} aria-label="Main">
        <NavLink href="/" icon="home">
          Home
        </NavLink>
        {(can(access, "reminders.create") || can(access, "reminders.view_all")) && (
          <NavLink href="/reminders" icon="reminders">
            Reminders
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
      </nav>
    </div>
  );
}
