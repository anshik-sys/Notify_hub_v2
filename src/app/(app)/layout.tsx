import { eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { companies } from "@/db/schema";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import styles from "./layout.module.css";
import { NavLink } from "./nav-link";

// Signed-in app shell: company name on top, tab bar at the bottom (thumb reach).
// Tabs are hidden by permission for tidiness only; every page checks again.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { companyId, access } = await requireMember();
  const [company] = await withTenant(companyId, (tx) =>
    tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)),
  );

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
