import { APIError } from "better-auth";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button, Checkbox, errorUrl, Field, firstParam, Form, Hint, Page, safeNext } from "@/components/form";
import { clientIp, limits } from "@/lib/rate-limit";
import { auth } from "@/lib/auth";

// Second step of a password sign-in with 2FA on (PRD 3.1). The pending
// sign-in lives in Better Auth's signed two-factor cookie (10 minutes); its
// rate limit and account lockout apply to these calls.
async function verify(formData: FormData) {
  "use server";
  const next = safeNext(formData.get("next"));
  const backup = formData.get("backup") === "1";
  const code = String(formData.get("code") ?? "").replace(/\s+/g, "");
  const here = `/sign-in/two-factor?${new URLSearchParams({ ...(backup ? { backup: "1" } : {}), ...(next === "/" ? {} : { next }) })}`;
  const limited = await limits([[`2fa:ip:${clientIp(await headers())}`, 10, 900]]);
  if (limited) redirect(errorUrl(here, limited));
  try {
    const body = { code, trustDevice: formData.get("trust") === "on" };
    if (backup) await auth.api.verifyBackupCode({ body, headers: await headers() });
    else await auth.api.verifyTOTP({ body, headers: await headers() });
  } catch (e) {
    if (e instanceof APIError) {
      // No pending sign-in (expired cookie, or none): start again.
      if (e.status === "UNAUTHORIZED" && /two factor|cookie/i.test(e.message))
        redirect(errorUrl("/sign-in", "That sign-in expired. Sign in again."));
      redirect(errorUrl(here, e.message || "That code didn't work."));
    }
    throw e;
  }
  redirect(next);
}

export default async function TwoFactor(props: PageProps<"/sign-in/two-factor">) {
  const sp = await props.searchParams;
  const backup = firstParam(sp.backup) === "1";
  const next = safeNext(firstParam(sp.next));
  const swap = `/sign-in/two-factor?${new URLSearchParams({ ...(backup ? {} : { backup: "1" }), ...(next === "/" ? {} : { next }) })}`;
  return (
    <Page center title="Two-factor check" error={firstParam(sp.error)}>
      <Form action={verify}>
        <input type="hidden" name="next" value={next} />
        {backup && <input type="hidden" name="backup" value="1" />}
        <Field
          label={backup ? "Backup code" : "Code from your authenticator app"}
          name="code"
          autoComplete="one-time-code"
          inputMode={backup ? "text" : "numeric"}
          required
          autoFocus
        />
        <Checkbox label="Trust this browser for 30 days" name="trust" />
        <Button>Continue</Button>
      </Form>
      <Hint>
        <Link href={swap}>{backup ? "Use your authenticator app instead" : "Use a backup code instead"}</Link>
      </Hint>
    </Page>
  );
}
