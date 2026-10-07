import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { withTenant } from "@/db";
import { companies } from "@/db/schema";
import { auth } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import styles from "./page.module.css";

async function signOut() {
  "use server";
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

export default async function Home() {
  const { user, companyId, access } = await requireMember();
  const [company] = await withTenant(companyId, (tx) =>
    tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)),
  );

  return (
    <main className={styles.home}>
      <h1 className={styles.company}>{company.name}</h1>
      <p>Signed in as {user.email}</p>
      {can(access, "users.view") && <Link href="/users">People</Link>}
      {can(access, "roles.manage") && <Link href="/settings/roles">Roles</Link>}
      <form action={signOut}>
        <button className={styles.signOut}>Sign out</button>
      </form>
    </main>
  );
}
