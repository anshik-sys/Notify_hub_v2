import { eq, sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { attachmentBlobs, companyLogos, reminderCovers, userPhotos } from "@/db/schema";

// File bytes. The only code that reads or writes attachment_blobs.
// ponytail: Postgres bytea (decided with the user: no new service, RLS + backups
// for free). Ceiling: database size. Upgrade path: an S3 version of these
// functions, keyed by attachment id; nothing else changes.

// A transaction (web, under RLS) or the worker's owner client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = Pick<PgTransaction<any, any, any>, "select" | "insert" | "delete" | "execute">;

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

// A task's cover image (one per task; replacing overwrites).
export const putCover = (tx: Tx, companyId: string, reminderId: string, contentType: string, data: Buffer) =>
  tx
    .insert(reminderCovers)
    .values({ reminderId, companyId, contentType, data })
    .onConflictDoUpdate({ target: reminderCovers.reminderId, set: { contentType, data, updatedAt: new Date() } });

export async function getCover(tx: Tx, reminderId: string) {
  const [row] = await tx.select({ contentType: reminderCovers.contentType, data: reminderCovers.data, updatedAt: reminderCovers.updatedAt }).from(reminderCovers).where(eq(reminderCovers.reminderId, reminderId));
  return row ?? null;
}

export const deleteCover = (tx: Tx, reminderId: string) => tx.delete(reminderCovers).where(eq(reminderCovers.reminderId, reminderId));

// Onto a copy or split of the task, in the database (no round trip of the bytes).
export const copyCover = (tx: Tx, from: string, to: string) =>
  tx.execute(sql`insert into reminder_covers (reminder_id, company_id, content_type, data)
    select ${to}, company_id, content_type, data from reminder_covers where reminder_id = ${from} on conflict do nothing`);
