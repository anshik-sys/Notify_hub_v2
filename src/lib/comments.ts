import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { attachments, commentMentions, comments, reminders, user } from "@/db/schema";
import { type CheckedFile, emailFiles, inEditWindow, mayRemoveFile } from "./attachments";
import { sendMail } from "./mail";
import { addNotifications, mutedFor, planTell, sendTell } from "./notifications";
import { type Access, can, loadAccess } from "./permissions";
import { reminderAccess } from "./reminders";
import { dmLink } from "./slack-installations";
import { getBlob, putBlob } from "./storage";

// Discussion on a reminder (PRD 5.11). Anyone who can see the reminder can
// comment. Mentions are explicit user ids from the composer, kept only if the
// person is in the company and their "@Name" is still in the text. A mention
// notifies only people who can see the reminder, so it never leaks one.

type Actor = { id: string; name: string; email: string; access: Access };
type Deps = { send?: typeof sendMail; slackFetch?: typeof fetch };
class Refused extends Error {}
const MAX_BODY = 5000;
const MAX_MENTIONS = 20;
export const MAX_FILES_PER_COMMENT = 5; // PRD 14.6 (CA1)
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function refusals<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Refused) return { error: e.message };
    throw e;
  }
}

// Files alone are a comment too (CA7).
function cleanBody(body: string, hasFiles = false) {
  const b = body.trim();
  if (!b && !hasFiles) throw new Refused("Write something first.");
  if (b.length > MAX_BODY) throw new Refused(`Comments are limited to ${MAX_BODY} characters.`);
  return b;
}

async function canSee(companyId: string, viewer: Actor, reminderId: string) {
  const [r] = await withTenant(companyId, (tx) =>
    tx.select({ id: reminders.id, createdBy: reminders.createdBy, title: reminders.title }).from(reminders).where(and(eq(reminders.id, reminderId), isNull(reminders.deletedAt))),
  );
  if (!r || !(await reminderAccess(companyId, viewer, r))) return null;
  return r;
}

// Company members among the ids whose "@Name" is in the body.
async function cleanMentions(companyId: string, body: string, ids: string[]) {
  const unique = [...new Set(ids)].slice(0, MAX_MENTIONS);
  if (!unique.length) return [];
  const people = await withTenant(companyId, (tx) =>
    tx
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(and(inArray(user.id, unique), isNull(user.deactivatedAt))),
  );
  return people.filter((p) => body.includes(`@${p.name}`));
}

// Notifies the people who can see the reminder: in-app always, email and Slack
// unless muted. Returns the names of those who can't see it, and the ids told.
async function notify(
  companyId: string,
  author: Actor,
  reminder: { id: string; title: string; createdBy: string },
  commentId: string,
  body: string,
  people: { id: string; name: string; email: string }[],
  deps: Deps,
) {
  const skipped: string[] = [];
  // CA3: the comment's files go with mention emails, within the email budget.
  const files = people.length ? await commentFiles(companyId, commentId) : [];
  const url = `${process.env.BETTER_AUTH_URL}/reminders/${reminder.id}#comment-${commentId}`;
  const quote = body.length > 500 ? `${body.slice(0, 500)}…` : body;
  const told: string[] = [];
  for (const p of people) {
    if (p.id === author.id) continue;
    const viewer = { id: p.id, email: p.email, access: await loadAccess(companyId, p.id) };
    if (!(await reminderAccess(companyId, viewer, reminder))) {
      skipped.push(p.name);
      continue;
    }
    told.push(p.id);
  }
  const muted = await withTenant(companyId, async (tx) => {
    await addNotifications(
      tx,
      told.map((userId) => ({
        companyId,
        userId,
        kind: "mention",
        reminderId: reminder.id,
        commentId,
        actorId: author.id,
        text: `${author.name} mentioned you: ${short(body)}`,
      })),
    );
    return mutedFor(tx, told, "mention");
  });
  const mail = told.length && files.length ? await emailFiles(files, (id) => withTenant(companyId, (tx) => getBlob(tx, id))) : { attached: [], tooBig: [] };
  for (const p of people.filter((x) => told.includes(x.id))) {
    const text = `${author.name} mentioned you on "${reminder.title}":\n\n${quote}`;
    const tooBig = mail.tooBig.length ? `\n\nToo big to attach, open it in NotifyHub: ${mail.tooBig.join(", ")}` : "";
    if (!muted.has(`${p.id}:email`))
      await (deps.send ?? sendMail)({
        to: p.email,
        subject: `${author.name} mentioned you: ${reminder.title}`,
        text: text + tooBig,
        links: [{ label: "Open the discussion", url }],
        attachments: mail.attached,
      }).catch((e) => console.error("mention email failed", e));
    if (!muted.has(`${p.id}:slack`))
      await dmLink(companyId, p.email, text, { label: "Open the discussion", url }, deps.slackFetch).catch((e) => console.error("mention Slack DM failed", e));
  }
  return { skipped, told };
}

const short = (body: string) => (body.length > 140 ? `${body.slice(0, 140)}…` : body);

export async function addComment(
  actor: Actor,
  companyId: string,
  reminderId: string,
  input: { body: string; parentId?: string | null; mentionIds: string[]; files?: CheckedFile[] },
  deps: Deps = {},
) {
  const result = await refusals(async () => {
    const files = input.files ?? [];
    if (files.length > MAX_FILES_PER_COMMENT) throw new Refused(`A comment can have at most ${MAX_FILES_PER_COMMENT} files.`);
    const body = cleanBody(input.body, files.length > 0);
    const reminder = await canSee(companyId, actor, reminderId);
    if (!reminder) throw new Refused("Reminder not found.");
    const people = await cleanMentions(companyId, body, input.mentionIds);
    const id = await withTenant(companyId, async (tx) => {
      let parentId: string | null = null;
      if (input.parentId) {
        const [parent] = await tx.select().from(comments).where(eq(comments.id, input.parentId));
        if (!parent || parent.reminderId !== reminderId) throw new Refused("That comment isn't on this reminder.");
        if (parent.deletedAt) throw new Refused("That comment was deleted.");
        parentId = parent.parentId ?? parent.id; // one level: replies to replies join the thread
      }
      const [row] = await tx
        .insert(comments)
        .values({ companyId, reminderId, authorId: actor.id, parentId, body })
        .returning({ id: comments.id });
      if (people.length)
        await tx.insert(commentMentions).values(people.map((p) => ({ commentId: row.id, companyId, userId: p.id })));
      await saveFiles(tx, companyId, reminderId, row.id, actor.id, files);
      return row.id;
    });
    const { skipped, told } = await notify(companyId, actor, reminder, id, body, people, deps);
    // The creator hears about every new comment by someone else, unless this
    // one already mentioned them: in the app, and by email or Slack if they
    // turned that on (off by default).
    if (reminder.createdBy !== actor.id && !told.includes(reminder.createdBy)) {
      const text = `${actor.name} commented: ${short(body || "(files)")}`;
      const tell = await withTenant(companyId, async (tx) => {
        await addNotifications(tx, [
          { companyId, userId: reminder.createdBy, kind: "comment", reminderId, commentId: id, actorId: actor.id, text },
        ]);
        return planTell(tx, companyId, [reminder.createdBy], "comment", {
          subject: `New comment on ${reminder.title}`,
          text,
          link: { label: "Open the discussion", url: `${process.env.BETTER_AUTH_URL}/reminders/${reminderId}#comment-${id}` },
        });
      });
      await sendTell(tell, deps.send, deps.slackFetch);
    }
    return { id, skipped };
  });
  return result;
}

export async function editComment(
  actor: Actor,
  companyId: string,
  commentId: string,
  input: { body: string; mentionIds: string[]; files?: CheckedFile[]; removeFileIds?: string[] },
  deps: Deps = {},
) {
  return refusals(async () => {
    const [c] = await withTenant(companyId, (tx) => tx.select().from(comments).where(eq(comments.id, commentId)));
    if (!c || c.authorId !== actor.id || c.deletedAt) throw new Refused("You can only edit your own comments.");
    // CE2, CE3: from posting; an edit doesn't restart it.
    if (!inEditWindow(c.createdAt)) throw new Refused("Comments can be edited for 24 hours after posting.");
    const remove = input.removeFileIds ?? [];
    const kept = (await commentFiles(companyId, commentId)).filter((f) => !remove.includes(f.id));
    const body = cleanBody(input.body, kept.length + (input.files?.length ?? 0) > 0);
    const reminder = await canSee(companyId, actor, c.reminderId);
    if (!reminder) throw new Refused("Reminder not found.");
    const people = await cleanMentions(companyId, body, input.mentionIds);
    const before = await withTenant(companyId, async (tx) => {
      const old = await tx.select({ userId: commentMentions.userId }).from(commentMentions).where(eq(commentMentions.commentId, commentId));
      await tx.update(comments).set({ body, editedAt: new Date() }).where(eq(comments.id, commentId));
      // AW1, AW4: your own files, within 24 hours of uploading them.
      if (remove.length) {
        const rows = await tx
          .select({ uploadedBy: attachments.uploadedBy, createdAt: attachments.createdAt })
          .from(attachments)
          .innerJoin(user, and(eq(user.id, attachments.uploadedBy), isNull(user.deactivatedAt))) // AW6
          .where(and(eq(attachments.commentId, commentId), inArray(attachments.id, remove)));
        if (rows.length !== new Set(remove).size || rows.some((f) => !mayRemoveFile(f, actor.id)))
          throw new Refused("You can only remove files you uploaded, for 24 hours after uploading.");
        await tx.delete(attachments).where(and(eq(attachments.commentId, commentId), inArray(attachments.id, remove)));
      }
      if (kept.length + (input.files?.length ?? 0) > MAX_FILES_PER_COMMENT) throw new Refused(`A comment can have at most ${MAX_FILES_PER_COMMENT} files.`);
      await saveFiles(tx, companyId, c.reminderId, commentId, actor.id, input.files ?? []);
      await tx.delete(commentMentions).where(eq(commentMentions.commentId, commentId));
      if (people.length) await tx.insert(commentMentions).values(people.map((p) => ({ commentId, companyId, userId: p.id })));
      return new Set(old.map((o) => o.userId));
    });
    // Only people newly mentioned by this edit hear about it.
    const fresh = people.filter((p) => !before.has(p.id));
    return { id: commentId, reminderId: c.reminderId, skipped: (await notify(companyId, actor, reminder, commentId, body, fresh, deps)).skipped };
  });
}

// The author, or anyone with comments.delete_any. Soft: the row stays (so
// replies keep context), the text and mentions go.
export async function deleteComment(actor: Actor, companyId: string, commentId: string) {
  return refusals(async () => {
    const [c] = await withTenant(companyId, (tx) => tx.select().from(comments).where(eq(comments.id, commentId)));
    if (!c || c.deletedAt) throw new Refused("Comment not found.");
    if (c.authorId !== actor.id && !can(actor.access, "comments.delete_any")) throw new Refused("You can only delete your own comments.");
    if (!(await canSee(companyId, actor, c.reminderId))) throw new Refused("Comment not found.");
    await withTenant(companyId, async (tx) => {
      await tx.update(comments).set({ body: "", deletedAt: new Date(), deletedBy: actor.id }).where(eq(comments.id, commentId));
      await tx.delete(commentMentions).where(eq(commentMentions.commentId, commentId));
      await tx.delete(attachments).where(eq(attachments.commentId, commentId)); // CA5
    });
    return { reminderId: c.reminderId };
  });
}

// Stored under the comment's reminder, so downloads use the reminder's access check (CA2).
async function saveFiles(tx: Tx, companyId: string, reminderId: string, commentId: string, by: string, files: CheckedFile[]) {
  for (const f of files) {
    const [row] = await tx
      .insert(attachments)
      .values({ companyId, reminderId, commentId, fileName: f.fileName, contentType: f.contentType, size: f.size, sha256: f.sha256, uploadedBy: by, createdAt: sql`clock_timestamp()` })
      .returning({ id: attachments.id });
    await putBlob(tx, row.id, companyId, f.data);
  }
}

const commentFiles = (companyId: string, commentId: string) =>
  withTenant(companyId, (tx) =>
    tx
      .select({ id: attachments.id, fileName: attachments.fileName, contentType: attachments.contentType, size: attachments.size })
      .from(attachments)
      .where(eq(attachments.commentId, commentId))
      .orderBy(attachments.createdAt),
  );

export type CommentFile = { id: string; fileName: string; size: number; uploadedBy: string | null; createdAt: Date };

export type ThreadComment = {
  id: string;
  authorId: string | null;
  authorName: string;
  body: string;
  createdAt: Date;
  edited: boolean;
  deleted: boolean;
  mentions: string[]; // names, for highlighting "@Name"
  files: CommentFile[];
  editable: boolean; // within 24 hours of posting (CE2)
};

// Top-level comments, each with its replies, oldest first.
export async function listComments(companyId: string, reminderId: string) {
  return withTenant(companyId, async (tx) => {
    const rows = await tx
      .select({
        id: comments.id,
        parentId: comments.parentId,
        authorId: comments.authorId,
        authorName: sql<string>`coalesce(${user.name}, 'Removed person')`,
        body: comments.body,
        createdAt: comments.createdAt,
        editedAt: comments.editedAt,
        deletedAt: comments.deletedAt,
      })
      .from(comments)
      .leftJoin(user, eq(user.id, comments.authorId))
      .where(eq(comments.reminderId, reminderId))
      .orderBy(asc(comments.createdAt));
    const mentions = rows.length
      ? await tx
          .select({ commentId: commentMentions.commentId, name: user.name })
          .from(commentMentions)
          .innerJoin(user, eq(user.id, commentMentions.userId))
          .where(
            inArray(
              commentMentions.commentId,
              rows.map((r) => r.id),
            ),
          )
      : [];
    const files = rows.length
      ? await tx
          .select({ id: attachments.id, commentId: attachments.commentId, fileName: attachments.fileName, size: attachments.size, uploadedBy: attachments.uploadedBy, createdAt: attachments.createdAt })
          .from(attachments)
          .where(inArray(attachments.commentId, rows.map((r) => r.id)))
          .orderBy(attachments.createdAt)
      : [];
    const toComment = (r: (typeof rows)[number]): ThreadComment => ({
      id: r.id,
      authorId: r.authorId,
      authorName: r.authorName,
      body: r.body,
      createdAt: r.createdAt,
      edited: Boolean(r.editedAt),
      deleted: Boolean(r.deletedAt),
      mentions: mentions.filter((m) => m.commentId === r.id).map((m) => m.name),
      files: files.filter((f) => f.commentId === r.id),
      editable: inEditWindow(r.createdAt),
    });
    return rows
      .filter((r) => !r.parentId)
      .map((r) => ({ ...toComment(r), replies: rows.filter((x) => x.parentId === r.id).map(toComment) }));
  });
}
