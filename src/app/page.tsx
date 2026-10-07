import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@/db";
import { companies } from "@/db/schema";
import { auth } from "@/lib/auth";
import styles from "./page.module.css";

async function signOut() {
  "use server";
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const companyId = session.user.companyId;
  if (!companyId) redirect("/onboarding");

  const [company] = await withTenant(companyId, (tx) =>
    tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)),
  );

  return (
    <main className={styles.home}>
      <h1 className={styles.company}>{company.name}</h1>
      <p>Signed in as {session.user.email}</p>
      <form action={signOut}>
        <button className={styles.signOut}>Sign out</button>
      </form>
    </main>
  );
}
