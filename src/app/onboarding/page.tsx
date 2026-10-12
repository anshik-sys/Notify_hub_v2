import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Button, errorUrl, firstParam, Form, Hint, Page } from "@/components/form";
import { signOutAction } from "../(app)/settings/account-actions";

// Where requireMember sends a signed-in person with no company. Companies are
// created by the platform owner only (decided 2026-10-12), so this is a dead end.
export default async function Onboarding(props: PageProps<"/onboarding">) {
  const error = firstParam((await props.searchParams).error);
  const session = await auth.api.getSession({ headers: await headers() });
  // A failed verification link lands here with ?error=TOKEN_EXPIRED etc. and no session.
  if (!session) redirect(error ? errorUrl("/sign-in", "That link is invalid or expired. Sign in to get a new one.") : "/sign-in");
  if (session.user.companyId) redirect("/");
  return (
    <Page center title="No company yet">
      <Hint>
        {session.user.email} isn’t part of a company on NotifyHub. Ask your company’s admin to invite you, then use the link in that email.
      </Hint>
      <Form action={signOutAction}>
        <Button variant="secondary">Sign out</Button>
      </Form>
    </Page>
  );
}
