import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ThemeToggle } from "@/components/theme-switcher";
import { platformAccess } from "@/lib/platform";
import { platformSignOutAction } from "./actions";
import styles from "./layout.module.css";
import { PlatformNav } from "./nav";

// The platform-owner console's own shell (PRD 9.2), outside any company: the
// app's look (canvas, white frame, pill nav) with a top bar instead of a
// sidebar. Non-owners get a 404 here and on every page and action. Anyone who
// isn't a full owner yet (signed out, a company account, no 2FA) gets the
// page bare on the canvas, like /sign-in; the pages themselves decide. An
// owner still without 2FA gets the frame, to set it up at /platform/security.
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const a = await platformAccess();
  if ("reason" in a && a.reason === "no") notFound();
  if (!("owner" in a) && a.reason !== "2fa") return children;
  return (
    <div className={styles.shell}>
      <div className={styles.frame}>
        <header className={styles.bar}>
          <Link href="/platform" className={styles.brand}>
            {/* Decorative: the link's text names it. */}
            <Image src="/logo.png" alt="" width={44} height={44} className={styles.logo} priority />
            <span className={styles.brandText}>
              <span className={styles.product}>NotifyHub</span>
              <span className={styles.sub}>Platform</span>
            </span>
          </Link>
          <PlatformNav />
          <div className={styles.tools}>
            <ThemeToggle className={styles.round} />
            <form action={platformSignOutAction}>
              <button className={styles.signOut}>Sign out</button>
            </form>
          </div>
        </header>
        <div className={styles.content}>
          {children}
        </div>
      </div>
    </div>
  );
}
