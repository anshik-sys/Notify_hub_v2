import Link from "next/link";
import type { EventAnswer } from "@/db/schema";
import { ANSWER_LABEL } from "@/lib/invite";
import { answerInviteAction } from "@/app/rsvp/actions";
import styles from "./rsvp-dialog.module.css";

// PRD 14.3: the reply pop-up for an emailed Yes / No / Maybe link. Shown over
// the dashboard (signed in) or a blurred stand-in (signed out). Server-rendered
// and open from the start: no client JS. Saving still takes a click, because
// mail scanners open links. Closing is a link away (the dashboard or sign-in).
export function RsvpDialog({
  token,
  target,
  picked,
  error,
  closeHref,
}: {
  token: string;
  target: { title: string; when: string; location: string | null; answer: EventAnswer | null };
  picked: EventAnswer | null; // the answer from the link
  error?: string;
  closeHref: string;
}) {
  const main = picked ?? target.answer;
  return (
    <div className={styles.scrim}>
      <div role="dialog" aria-modal="true" aria-labelledby="rsvp-title" className={styles.dialog}>
        <p className={styles.kicker}>You’re invited</p>
        <h2 id="rsvp-title" className={styles.title}>
          {target.title}
        </h2>
        <p className={styles.meta}>{target.when}</p>
        {target.location && <p className={styles.meta}>{target.location}</p>}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <p className={styles.question}>
          {target.answer ? `Your answer: ${ANSWER_LABEL[target.answer]}. Change it?` : "Will you come?"}
        </p>
        <form action={answerInviteAction} className={styles.answers}>
          <input type="hidden" name="token" value={token} />
          {(["yes", "maybe", "no"] as const).map((a) => (
            <button key={a} name="answer" value={a} className={a === main ? `${styles.answer} ${styles.picked}` : styles.answer} autoFocus={a === main}>
              {ANSWER_LABEL[a]}
            </button>
          ))}
        </form>
        <Link href={closeHref} className={styles.close}>
          Not now
        </Link>
      </div>
    </div>
  );
}
