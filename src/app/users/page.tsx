import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/lib/permissions";
import { requireMember } from "@/lib/session";
import { listUsers } from "@/lib/users";
import { firstParam, FormPage, Hint } from "../form";
import { revokeInvite } from "./actions";
import styles from "./page.module.css";

export default async function Users(props: PageProps<"/users">) {
  const { companyId, access } = await requireMember();
  if (!can(access, "users.view")) notFound();
  const { users, pending } = await listUsers(companyId);
  const { error, notice } = await props.searchParams;
  const canInvite = can(access, "users.create");

  return (
    <FormPage title="People" error={firstParam(error)} notice={firstParam(notice)}>
      {canInvite && (
        <Link href="/users/invite" className={styles.invite}>
          Invite someone
        </Link>
      )}
      <ul className={styles.list}>
        {users.map((u) => (
          <li key={u.id} className={styles.row}>
            <div className={styles.who}>
              <Link href={`/users/${u.id}`}>{u.name}</Link>
              <span className={styles.meta}>{u.email}</span>
            </div>
            <span className={styles.meta}>{u.deactivatedAt ? "Deactivated" : u.roles.join(", ")}</span>
          </li>
        ))}
      </ul>
      {canInvite && pending.length > 0 && (
        <>
          <h2 className={styles.heading}>Pending invites</h2>
          <ul className={styles.list}>
            {pending.map((p) => (
              <li key={p.id} className={styles.row}>
                <div className={styles.who}>
                  {p.email}
                  <span className={styles.meta}>Expires {p.expiresAt.toISOString().slice(0, 10)}</span>
                </div>
                <form action={revokeInvite}>
                  <input type="hidden" name="id" value={p.id} />
                  <button className={styles.revoke}>Revoke</button>
                </form>
              </li>
            ))}
          </ul>
        </>
      )}
      <Hint>
        <Link href="/">Back</Link>
      </Hint>
    </FormPage>
  );
}
