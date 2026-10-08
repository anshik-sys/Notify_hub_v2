import Link from "next/link";
import { notFound } from "next/navigation";
import { platformAccess } from "@/lib/platform";
import { signOutAction } from "../(app)/settings/account-actions";
import styles from "./layout.module.css";

// The platform-owner console's own shell (PRD 9.2), outside any company.
// Non-owners get a 404 here and on every page and action.
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const a = await platformAccess();
  if ("reason" in a && a.reason === "no") notFound();
  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <span className={styles.brand}>NotifyHub platform</span>
        {"owner" in a && (
          <nav className={styles.nav}>
            <Link href="/platform">Companies</Link>
            <Link href="/platform/settings">Settings</Link>
            <Link href="/account/security">Security</Link>
            <form action={signOutAction}>
              <button className={styles.signOut}>Sign out</button>
            </form>
          </nav>
        )}
      </header>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
