import { Avatar } from "@/components/avatar";
import { Button, Section } from "@/components/form";
import type { ThreadComment } from "@/lib/comments";
import { formatInZone } from "@/lib/time";
import { deleteCommentAction, editCommentAction, postComment } from "../comment-actions";
import { MentionTextarea } from "../mention-textarea";
import styles from "./discussion.module.css";

type Person = { id: string; name: string; email: string };
type Props = {
  reminderId: string;
  timeZone: string;
  thread: (ThreadComment & { replies: ThreadComment[] })[];
  people: Person[];
  viewerId: string;
  canModerate: boolean;
};

// "@Name" for a real mention is highlighted; everything is rendered as text
// (React escapes it), never as HTML.
function Body({ text, mentions }: { text: string; mentions: string[] }) {
  if (!mentions.length) return <p className={styles.body}>{text}</p>;
  const names = [...mentions].sort((a, b) => b.length - a.length).map((n) => `@${n}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${names.join("|")})`, "g"));
  return (
    <p className={styles.body}>
      {parts.map((part, i) =>
        i % 2 ? (
          <span key={i} className={styles.mention}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </p>
  );
}

function Comment({ c, threadId, p }: { c: ThreadComment; threadId: string; p: Props }) {
  const mine = c.authorId === p.viewerId;
  return (
    <article id={`comment-${c.id}`} className={styles.comment}>
      {c.deleted ? <span className={styles.avatarGap} /> : <Avatar name={c.authorName} />}
      <div className={styles.main}>
        <header className={styles.meta}>
          {!c.deleted && <strong>{c.authorName}</strong>}
          <span>{formatInZone(c.createdAt, p.timeZone)}</span>
          {c.edited && !c.deleted && <span>(edited)</span>}
        </header>
        {c.deleted ? <p className={styles.deleted}>Comment deleted</p> : <Body text={c.body} mentions={c.mentions} />}
        {!c.deleted && (
          <>
            {/* The toggles stay in one row; CSS shows the open one's form under it. */}
            <div className={styles.actions}>
              <details className={`${styles.toggle} ${styles.replyToggle}`}>
                <summary className={styles.action}>Reply</summary>
              </details>
              {mine && (
                <details className={`${styles.toggle} ${styles.editToggle}`}>
                  <summary className={styles.action}>Edit</summary>
                </details>
              )}
              {(mine || p.canModerate) && (
                <form action={deleteCommentAction}>
                  <input type="hidden" name="reminderId" value={p.reminderId} />
                  <input type="hidden" name="commentId" value={c.id} />
                  <button className={`${styles.action} ${styles.delete}`}>Delete</button>
                </form>
              )}
            </div>
            <form action={postComment} className={`${styles.form} ${styles.replyForm}`}>
              <input type="hidden" name="reminderId" value={p.reminderId} />
              <input type="hidden" name="parentId" value={threadId} />
              <MentionTextarea people={p.people} label="Reply" />
              <Button size="small">Post reply</Button>
            </form>
            {mine && (
              <form action={editCommentAction} className={`${styles.form} ${styles.editForm}`}>
                <input type="hidden" name="reminderId" value={p.reminderId} />
                <input type="hidden" name="commentId" value={c.id} />
                <MentionTextarea
                  people={p.people}
                  label="Edit comment"
                  defaultValue={c.body}
                  defaultMentions={p.people.filter((x) => c.mentions.includes(x.name)).map((x) => x.id)}
                />
                <Button size="small">Save</Button>
              </form>
            )}
          </>
        )}
      </div>
    </article>
  );
}

export function Discussion(p: Props) {
  const count = p.thread.reduce((n, c) => n + (c.deleted ? 0 : 1) + c.replies.filter((r) => !r.deleted).length, 0);
  return (
    <Section id="discussion" title={`Discussion (${count})`}>
      {p.thread.length === 0 && <p className={styles.empty}>No comments yet.</p>}
      {p.thread.map((c) => (
        <div key={c.id} className={styles.thread}>
          <Comment c={c} threadId={c.id} p={p} />
          {c.replies.length > 0 && (
            <div className={styles.replies}>
              {c.replies.map((r) => (
                <Comment key={r.id} c={r} threadId={c.id} p={p} />
              ))}
            </div>
          )}
        </div>
      ))}
      <form action={postComment} className={styles.form}>
        <input type="hidden" name="reminderId" value={p.reminderId} />
        <MentionTextarea people={p.people} label="Add a comment" />
        <Button>Post comment</Button>
      </form>
    </Section>
  );
}
