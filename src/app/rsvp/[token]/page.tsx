import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { firstParam, Hint, Page } from "@/components/form";
import { RsvpDialog } from "@/components/rsvp-dialog";
import { auth } from "@/lib/auth";
import { rsvpTarget } from "@/lib/events";
import { isAnswer, readRsvp } from "@/lib/invite";
import styles from "./page.module.css";

// PRD 14.3 (RS2), from the Yes / No / Maybe links in an invite email. The
// guest's own session: the pop-up opens over their dashboard. Signed out: it
// opens here, over a blurred stand-in, and saves without signing in. Signed in
// as someone else: it says whose invite it is and offers to sign out.
export default async function Rsvp(props: PageProps<"/rsvp/[token]">) {
  const { token } = await props.params;
  const sp = await props.searchParams;
  const picked = firstParam(sp.a);
  const session = await auth.api.getSession({ headers: await headers() });
  if (session && session.user.id === readRsvp(token)?.userId)
    redirect(`/?rsvp=${encodeURIComponent(token)}${isAnswer(picked) ? `&a=${picked}` : ""}`);
  const target = await rsvpTarget(token);
  if (!target)
    return (
      <Page center title="Link not valid">
        <Hint>This link isn&rsquo;t valid, or the event was deleted.</Hint>
      </Page>
    );
  return (
    <>
      {/* A stand-in for the app behind the pop-up: blurred shapes, no data. */}
      <div className={styles.backdrop} aria-hidden="true">
        <div className={styles.rail} />
        <div className={styles.body}>
          <div className={styles.bar} />
          <div className={styles.cards}>
            <div />
            <div />
            <div />
          </div>
          <div className={styles.panel} />
        </div>
      </div>
      <RsvpDialog
        token={token}
        target={target}
        picked={isAnswer(picked) ? picked : null}
        error={firstParam(sp.error)}
        closeHref={session ? "/" : "/sign-in"}
        signedInAs={session?.user.name}
        saved={Boolean(firstParam(sp.saved))}
      />
    </>
  );
}
