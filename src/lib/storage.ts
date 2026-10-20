import { eq } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { attachmentBlobs, companyLogos, userPhotos } from "@/db/schema";

// File bytes. The only code that reads or writes attachment_blobs.
// ponytail: Postgres bytea (decided with the user: no new service, RLS + backups
// for free). Ceiling: database size. Upgrade path: an S3 version of these
// functions, keyed by attachment id; nothing else changes.

// A transaction (web, under RLS) or the worker's owner client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = Pick<PgTransaction<any, any, any>, "select" | "insert" | "delete">;

export const putBlob = (tx: Tx, attachmentId: string, companyId: string, data: Buffer) =>
  tx.insert(attachmentBlobs).values({ attachmentId, companyId, data });

export async function getBlob(tx: Tx, attachmentId: string) {
  const [row] = await tx.select({ data: attachmentBlobs.data }).from(attachmentBlobs).where(eq(attachmentBlobs.attachmentId, attachmentId));
  return row?.data ?? null;
}

// The company logo (one per company; replacing overwrites).
export const putLogo = (tx: Tx, companyId: string, contentType: string, data: Buffer) =>
  tx
    .insert(companyLogos)
    .values({ companyId, contentType, data })
    .onConflictDoUpdate({ target: companyLogos.companyId, set: { contentType, data, updatedAt: new Date() } });

export async function getLogo(tx: Tx, companyId: string) {
  const [row] = await tx.select({ contentType: companyLogos.contentType, data: companyLogos.data, updatedAt: companyLogos.updatedAt }).from(companyLogos).where(eq(companyLogos.companyId, companyId));
  return row ?? null;
}

export const deleteLogo = (tx: Tx, companyId: string) => tx.delete(companyLogos).where(eq(companyLogos.companyId, companyId));

// A person's profile photo (one per person; replacing overwrites).
export const putPhoto = (tx: Tx, companyId: string, userId: string, contentType: string, data: Buffer) =>
  tx
    .insert(userPhotos)
    .values({ userId, companyId, contentType, data })
    .onConflictDoUpdate({ target: userPhotos.userId, set: { contentType, data, updatedAt: new Date() } });

export async function getPhoto(tx: Tx, userId: string) {
  const [row] = await tx.select({ contentType: userPhotos.contentType, data: userPhotos.data, updatedAt: userPhotos.updatedAt }).from(userPhotos).where(eq(userPhotos.userId, userId));
  return row ?? null;
}

export const deletePhoto = (tx: Tx, userId: string) => tx.delete(userPhotos).where(eq(userPhotos.userId, userId)).returning({ userId: userPhotos.userId });
