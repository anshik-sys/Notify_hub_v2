import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button, Field, firstParam, Form, Hint, Page } from "@/components/form";
import { clientIp, limits } from "@/lib/rate-limit";
import { auth } from "@/lib/auth";

// PRD 3.2. The answer is the same whether or not the account exists.
async function request(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const limited = await limits([
    [`forgot:email:${email}`, 3, 3600],
    [`forgot:ip:${clientIp(await headers())}`, 10, 3600],
  ]);
  if (limited) redirect(`/forgot-password?error=${encodeURIComponent(limited)}`);
  await auth.api
    .requestPasswordReset({ body: { email, redirectTo: "/reset-password" }, headers: await headers() })
    .catch((e) => console.error("password reset request failed", e));
  redirect(`/forgot-password?notice=${encodeURIComponent("If that account exists, we've emailed a link to reset the password. It works once, for 1 hour.")}`);
}

export default async function ForgotPassword(props: PageProps<"/forgot-password">) {
  const sp = await props.searchParams;
  return (
    <Page center title="Reset your password" notice={firstParam(sp.notice)} error={firstParam(sp.error)}>
      <Form action={request}>
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Button>Email me a link</Button>
      </Form>
      <Hint>
        <Link href="/sign-in">Back to sign in</Link>
      </Hint>
    </Page>
  );
}
