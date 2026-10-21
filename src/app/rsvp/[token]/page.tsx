import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Button, firstParam, Form, Hint, Page } from "@/components/form";
import { respondByToken, rsvpTarget } from "@/lib/events";
import { ANSWER_LABEL, isAnswer } from "@/lib/invite";
import { clientIp, limits } from "@/lib/rate-limit";
import styles from "./page.module.css";

// PRD 14.3 (RS2), from the Yes / No / Maybe links in an invite email. No
// sign-in: the signed token names the guest. Saving takes a click, so mail
// scanners that open links don't answer for people.
async function answer(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const back = `/rsvp/${encodeURIComponent(token)}`;
  const limited = await limits([[`rsvp:ip:${clientIp(await headers())}`, 60, 3600]]);
  if (limited) redirect(`${back}?error=${encodeURIComponent(limited)}`);
  const error = await respondByToken(token, formData.get("answer"));
  redirect(`${back}?${error ? `error=${encodeURIComponent(error)}` : "saved=1"}`);
}

export default async function Rsvp(props: PageProps<"/rsvp/[token]">) {
  const { token } = await props.params;
  const sp = await props.searchParams;
  const target = await rsvpTarget(token);
  if (!target)
    return (
      <Page center title="Link not valid">
        <Hint>This link isn&rsquo;t valid, or the event was deleted.</Hint>
      </Page>
    );
  // The answer from the link is the main button; the others stay available.
  const picked = firstParam(sp.a);
  const main = isAnswer(picked) ? picked : null;
  return (
    <Page center title={target.title} error={firstParam(sp.error)} notice={firstParam(sp.saved) ? "Answer saved." : undefined}>
      <Hint>{target.when}</Hint>
      {target.location && <Hint>Where: {target.location}</Hint>}
      <Hint>
        {target.answer ? `${target.name}, your answer: ${ANSWER_LABEL[target.answer]}.` : `${target.name}, will you come?`} You can change it until the event
        ends.
      </Hint>
      <Form action={answer}>
        <input type="hidden" name="token" value={token} />
        <div className={styles.answers}>
          {(["yes", "maybe", "no"] as const).map((a) => (
            <Button key={a} name="answer" value={a} variant={a === (main ?? target.answer) ? undefined : "secondary"}>
              {ANSWER_LABEL[a]}
            </Button>
          ))}
        </div>
      </Form>
    </Page>
  );
}
