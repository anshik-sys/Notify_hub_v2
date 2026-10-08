import { APIError } from "better-auth";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button, errorUrl, Field, firstParam, Form, Hint, Page } from "@/components/form";
import { clientIp, limits } from "@/lib/rate-limit";
import { auth } from "@/lib/auth";

// The emailed link lands here with ?token=. Single use, 1 hour; a reset signs
// out every session (src/lib/auth.ts).
async function reset(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const [password, confirm] = [String(formData.get("password") ?? ""), String(formData.get("confirm") ?? "")];
  const back = (m: string) => redirect(errorUrl(`/reset-password?token=${encodeURIComponent(token)}`, m));
  const limited = await limits([[`reset:ip:${clientIp(await headers())}`, 10, 3600]]);
  if (limited) back(limited);
  if (password !== confirm) back("The passwords don't match.");
  try {
    await auth.api.resetPassword({ body: { token, newPassword: password }, headers: await headers() });
  } catch (e) {
    if (e instanceof APIError) back(/token/i.test(e.message) ? "This link has expired or was already used. Ask for a new one." : e.message);
    throw e;
  }
  redirect(`/sign-in?notice=${encodeURIComponent("Password changed. Sign in with the new one.")}`);
}

export default async function ResetPassword(props: PageProps<"/reset-password">) {
  const sp = await props.searchParams;
  const token = firstParam(sp.token) ?? "";
  // Better Auth sends ?error=INVALID_TOKEN when the link is bad or used.
  const error = firstParam(sp.error) === "INVALID_TOKEN" ? "This link has expired or was already used. Ask for a new one." : firstParam(sp.error);
  return (
    <Page center title="Choose a new password" error={error}>
      {token ? (
        <Form action={reset}>
          <input type="hidden" name="token" value={token} />
          <Field label="New password" name="password" type="password" autoComplete="new-password" minLength={8} required />
          <Field label="Repeat it" name="confirm" type="password" autoComplete="new-password" minLength={8} required />
          <Button>Change password</Button>
        </Form>
      ) : (
        <Hint>
          <Link href="/forgot-password">Ask for a new link</Link>
        </Hint>
      )}
    </Page>
  );
}
