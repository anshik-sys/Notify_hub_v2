import { APIError } from "better-auth";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { acceptInvitation, accountExists, findInvitation } from "@/lib/invitations";
import { Button, errorUrl, Field, firstParam, Form, FormPage, Hint } from "../../form";

// Public page: the token in the URL is the only credential.
async function joinAsCurrentUser(formData: FormData) {
  "use server";
  const token = String(formData.get("token"));
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);
  const error = await acceptInvitation(token, session.user.id);
  if (error) redirect(errorUrl(`/invite/${token}`, error));
  redirect("/");
}

async function createAccountAndJoin(formData: FormData) {
  "use server";
  const token = String(formData.get("token"));
  const back = (m: string) => errorUrl(`/invite/${token}`, m);
  const invite = await findInvitation(token);
  if (!invite) redirect(back("This invite is invalid, expired or already used."));
  if (await accountExists(invite.email)) redirect(back("You already have an account. Sign in to accept."));
  const password = String(formData.get("password"));
  const h = await headers();

  let userId: string;
  try {
    const res = await auth.api.signUpEmail({ body: { name: String(formData.get("name")), email: invite.email, password }, headers: h });
    userId = res.user.id;
  } catch (e) {
    if (e instanceof APIError) redirect(back(e.message));
    throw e;
  }
  const error = await acceptInvitation(token, userId);
  if (error) redirect(back(error));
  // Verified by accepting, so this sign-in goes through and sets the cookie.
  await auth.api.signInEmail({ body: { email: invite.email, password }, headers: h });
  redirect("/");
}

export default async function Invite(props: PageProps<"/invite/[token]">) {
  const { token } = await props.params;
  const error = firstParam((await props.searchParams).error);
  const invite = await findInvitation(token);
  if (!invite)
    return (
      <FormPage title="Invite" error={error}>
        <Hint>This invite is invalid, expired or already used. Ask your admin for a new one.</Hint>
      </FormPage>
    );

  const title = `Join ${invite.companyName}`;
  const session = await auth.api.getSession({ headers: await headers() });

  if (session) {
    if (session.user.email.toLowerCase() !== invite.email)
      return (
        <FormPage title={title} error={error}>
          <Hint>
            This invite is for {invite.email}, but you’re signed in as {session.user.email}. Sign out, then open the
            link again.
          </Hint>
        </FormPage>
      );
    return (
      <FormPage title={title} error={error}>
        <Form action={joinAsCurrentUser}>
          <input type="hidden" name="token" value={token} />
          <Button>Join {invite.companyName}</Button>
        </Form>
      </FormPage>
    );
  }

  if (await accountExists(invite.email))
    return (
      <FormPage title={title} error={error}>
        <Hint>
          You already have an account as {invite.email}.{" "}
          <Link href={`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to accept</Link>
        </Hint>
      </FormPage>
    );

  return (
    <FormPage title={title} error={error}>
      <Form action={createAccountAndJoin}>
        <input type="hidden" name="token" value={token} />
        <Field label="Email" value={invite.email} readOnly />
        <Field label="Full name" name="name" autoComplete="name" required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={8} required />
        <Button>Create account and join</Button>
      </Form>
    </FormPage>
  );
}
