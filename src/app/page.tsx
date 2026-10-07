import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@/db";
import { companies } from "@/db/schema";
import { auth } from "@/lib/auth";

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
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">{company.name}</h1>
      <p>Signed in as {session.user.email}</p>
      <form action={signOut}>
        <button className="underline">Sign out</button>
      </form>
    </main>
  );
}
