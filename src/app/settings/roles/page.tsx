import Link from "next/link";
import { notFound } from "next/navigation";
import { can, visibleRoles } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { FormPage, Hint } from "../../form";
import styles from "./page.module.css";

export default async function Roles() {
  const { companyId, access } = await requireMember();
  if (!can(access, "roles.manage")) notFound();
  const roles = await visibleRoles(companyId);

  return (
    <FormPage title="Roles">
      <ul className={styles.list}>
        {roles.map((r) => (
          <li key={r.id} className={styles.row}>
            <Link href={`/settings/roles/${r.id}`}>{r.name}</Link>
            <span className={styles.meta}>
              {r.companyId === null ? "Built-in" : `${r.permissions.length} permissions`}
            </span>
          </li>
        ))}
      </ul>
      <Link href="/settings/roles/new" className={styles.newRole}>
        New role
      </Link>
      <Hint>
        <Link href="/">Back</Link>
      </Hint>
    </FormPage>
  );
}
