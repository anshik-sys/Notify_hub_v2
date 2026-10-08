import { after } from "next/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button, errorUrl, firstParam, Form, Hint, Page, TextArea } from "@/components/form";
import { IMPORT_MAX_ROWS, importInvitations } from "@/lib/invitations";
import { can } from "@/lib/permissions";
import { limits } from "@/lib/rate-limit";
import { requireMember } from "@/lib/session";
import styles from "./page.module.css";

const MAX_BYTES = 1024 * 1024;

async function importAction(fd: FormData) {
  "use server";
  const { user, companyId, access } = await requireMember();
  if (!can(access, "users.create")) notFound();
  const back = (m: string) => redirect(errorUrl("/users/import", m));
  const limited = await limits([[`import:user:${user.id}`, 5, 3600]]);
  if (limited) back(limited);
  const file = fd.get("file");
  let text = String(fd.get("text") ?? "");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_BYTES) back("The file is larger than 1 MB.");
    text = await file.text();
  }
  if (!text.trim()) back("Choose a CSV file or paste the rows.");
  const r = await importInvitations({ id: user.id, name: user.name, access }, companyId, text);
  if ("errors" in r) back(`Nothing was imported. ${r.errors!.join(" ")}`);
  const ok = r as Exclude<typeof r, { errors: string[] }>;
  after(ok.sendAll); // invite emails go out after this response
  const skipped = ok.skipped.length ? ` Skipped ${ok.skipped.length} already in the company: ${ok.skipped.slice(0, 5).join(", ")}${ok.skipped.length > 5 ? "…" : ""}.` : "";
  redirect(`/users?notice=${encodeURIComponent(`Invited ${ok.invited.length} ${ok.invited.length === 1 ? "person" : "people"}.${skipped}`)}`);
}

// PRD 9.1: bulk import of people as invitations.
export default async function ImportPeople(props: PageProps<"/users/import">) {
  const { access } = await requireMember();
  if (!can(access, "users.create")) notFound();
  const error = firstParam((await props.searchParams).error);
  return (
    <Page title="Import people" back={{ href: "/users", label: "Team" }} error={error}>
      <Hint>
        A CSV with a header row: <code>email</code> (required), <code>departments</code> and <code>roles</code> (optional, names separated
        by <code>;</code>). Everyone gets an invite email and sets their own password. Up to {IMPORT_MAX_ROWS} people at a time. If any row
        has a problem, nothing is imported and every problem is listed.
      </Hint>
      <p>
        <Link href="/users/import/template.csv">Download a template</Link>
      </p>
      <Form action={importAction}>
        <label className={styles.file}>
          CSV file
          <input type="file" name="file" accept=".csv,text/csv" />
        </label>
        <TextArea label="…or paste the rows" name="text" rows={6} placeholder={"email,departments,roles\nana@example.com,Operations,"} />
        <Button>Import and send invites</Button>
      </Form>
    </Page>
  );
}
