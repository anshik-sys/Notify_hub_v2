import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Button, firstParam, Form, Hint, Page } from "@/components/form";
import { clientIp, limits } from "@/lib/rate-limit";
import { resubscribe, unsubscribe, unsubscribeTarget } from "@/lib/unsubscribe";

// PRD 7.1, from the link in an email to an outside address. No sign-in: the
// token is the proof. A button rather than unsubscribing on open, so mail
// scanners that follow links don't unsubscribe people. The same link lets the
// person subscribe again; nobody else can do that for them.
async function change(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const again = formData.get("op") === "resubscribe";
  const back = `/unsubscribe/${encodeURIComponent(token)}`;
  const limited = await limits([[`unsubscribe:ip:${clientIp(await headers())}`, 30, 3600]]);
  if (limited) redirect(`${back}?error=${encodeURIComponent(limited)}`);
  const error = again ? await resubscribe(token) : await unsubscribe(token);
  redirect(`${back}?${error ? `error=${encodeURIComponent(error)}` : again ? "resubscribed=1" : "done=1"}`);
}

const ChangeForm = ({ token, op, label, secondary }: { token: string; op: string; label: string; secondary?: boolean }) => (
  <Form action={change}>
    <input type="hidden" name="token" value={token} />
    <input type="hidden" name="op" value={op} />
    <Button variant={secondary ? "secondary" : undefined}>{label}</Button>
  </Form>
);

export default async function Unsubscribe(props: PageProps<"/unsubscribe/[token]">) {
  const { token } = await props.params;
  const sp = await props.searchParams;
  const target = await unsubscribeTarget(token);
  if (!target)
    return (
      <Page center title="Link not valid">
        <Hint>This unsubscribe link isn&rsquo;t valid. Use the link from the most recent email you got.</Hint>
      </Page>
    );
  if (firstParam(sp.done))
    return (
      <Page center title="You're unsubscribed">
        <Hint>
          {target.email} won&rsquo;t get any more reminders from {target.companyName} through NotifyHub. Changed your mind?
        </Hint>
        <ChangeForm token={token} op="resubscribe" label="Subscribe again" secondary />
      </Page>
    );
  return (
    <Page center title={firstParam(sp.resubscribed) ? "You're subscribed again" : "Unsubscribe"} error={firstParam(sp.error)}>
      <Hint>
        {firstParam(sp.resubscribed)
          ? `${target.email} will get reminders from ${target.companyName} again. You can unsubscribe at any time.`
          : `Stop all reminders from ${target.companyName} to ${target.email}?`}
      </Hint>
      <ChangeForm token={token} op="unsubscribe" label="Unsubscribe" />
    </Page>
  );
}
