import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Button, firstParam, Form, Hint, Page } from "@/components/form";
import { clientIp, limits } from "@/lib/rate-limit";
import { unsubscribe, unsubscribeTarget } from "@/lib/unsubscribe";

// PRD 7.1, from the link in an email to an outside address. No sign-in: the
// token is the proof. A button rather than unsubscribing on open, so mail
// scanners that follow links don't unsubscribe people.
async function confirm(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const back = `/unsubscribe/${encodeURIComponent(token)}`;
  const limited = await limits([[`unsubscribe:ip:${clientIp(await headers())}`, 30, 3600]]);
  if (limited) redirect(`${back}?error=${encodeURIComponent(limited)}`);
  const error = await unsubscribe(token);
  redirect(`${back}?${error ? `error=${encodeURIComponent(error)}` : "done=1"}`);
}

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
          {target.email} won&rsquo;t get any more reminders from {target.companyName} through NotifyHub.
        </Hint>
      </Page>
    );
  return (
    <Page center title="Unsubscribe" error={firstParam(sp.error)}>
      <Hint>
        Stop all reminders from {target.companyName} to {target.email}?
      </Hint>
      <Form action={confirm}>
        <input type="hidden" name="token" value={token} />
        <Button>Unsubscribe</Button>
      </Form>
    </Page>
  );
}
