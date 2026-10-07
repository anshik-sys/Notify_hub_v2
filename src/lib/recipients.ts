import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { departmentMembers, groupMembers, user } from "@/db/schema";

// Imports only the schema: the worker uses this too and must not pull in the
// web app's DB client.

// Any drizzle transaction: the web's withTenant one, or the worker's owner one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tx = PgTransaction<any, any, any>;

// slack_channel targets don't resolve to people (the worker posts to the
// channel); label is the channel name, for display.
export type Target = {
  kind: "user" | "department" | "group" | "company" | "email" | "slack_channel";
  ref: string | null;
  label?: string | null;
};

// Targets -> who actually gets it, as of now. Used for the scope check and at
// send time. Filters by companyId explicitly as well: the worker's connection
// bypasses RLS.
export async function resolveRecipients(tx: Tx, companyId: string, targets: Target[]) {
  const active = and(eq(user.companyId, companyId), isNull(user.deactivatedAt));
  const pick = { id: user.id, email: user.email };
  const refs = (kind: Target["kind"]) => targets.filter((t) => t.kind === kind).map((t) => t.ref!);
  const emails = refs("email");
  let rows: { id: string; email: string }[] = [];

  if (targets.some((t) => t.kind === "company")) {
    rows = await tx.select(pick).from(user).where(active);
  } else {
    const [userIds, deptIds, groupIds] = [refs("user"), refs("department"), refs("group")];
    if (userIds.length) rows.push(...(await tx.select(pick).from(user).where(and(active, inArray(user.id, userIds)))));
    if (deptIds.length)
      rows.push(
        ...(await tx
          .select(pick)
          .from(departmentMembers)
          .innerJoin(user, eq(user.id, departmentMembers.userId))
          .where(and(active, eq(departmentMembers.companyId, companyId), inArray(departmentMembers.departmentId, deptIds)))),
      );
    if (groupIds.length)
      rows.push(
        ...(await tx
          .select(pick)
          .from(groupMembers)
          .innerJoin(user, eq(user.id, groupMembers.userId))
          .where(and(active, eq(groupMembers.companyId, companyId), inArray(groupMembers.groupId, groupIds)))),
      );
  }
  // A typed email belonging to a company member is that member.
  if (emails.length)
    rows.push(...(await tx.select(pick).from(user).where(and(active, inArray(sql`lower(${user.email})`, emails)))));

  const users = new Map<string, { id: string; email: string }>();
  for (const r of rows) users.set(r.email.toLowerCase(), { id: r.id, email: r.email.toLowerCase() });
  const external = emails.filter((e) => !users.has(e));
  return { users: [...users.values()], external };
}

