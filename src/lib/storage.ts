import { eq } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { attachmentBlobs } from "@/db/schema";

// File bytes. The only code that reads or writes attachment_blobs.
// ponytail: Postgres bytea (decided with the user: no new service, RLS + backups
// for free). Ceiling: database size. Upgrade path: an S3 version of these
// three functions, keyed by attachment id; nothing else changes.

// A transaction (web, under RLS) or the worker's owner client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = Pick<PgTransaction<any, any, any>, "select" | "insert" | "delete">;

export const putBlob = (tx: Tx, attachmentId: string, companyId: string, data: Buffer) =>
  tx.insert(attachmentBlobs).values({ attachmentId, companyId, data });

export async function getBlob(tx: Tx, attachmentId: string) {
  const [row] = await tx.select({ data: attachmentBlobs.data }).from(attachmentBlobs).where(eq(attachmentBlobs.attachmentId, attachmentId));
  return row?.data ?? null;
}

// Deleting the attachment row cascades; this is for an explicit blob-only delete.
export const deleteBlob = (tx: Tx, attachmentId: string) => tx.delete(attachmentBlobs).where(eq(attachmentBlobs.attachmentId, attachmentId));
