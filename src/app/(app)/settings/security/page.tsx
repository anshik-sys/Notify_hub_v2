import { cookies, headers } from "next/headers";
import { Button, Field, firstParam, Form, Hint, Page, Section } from "@/components/form";
import { Badge, Muted, Table } from "@/components/table";
import { describeAgent, hasPassword, listMySessions, totpQrSvg } from "@/lib/account";
import { auth } from "@/lib/auth";
import { requireMember } from "@/lib/session";
import { formatInZone } from "@/lib/time";
import {
  changePasswordAction,
  confirmTwoFactorAction,
  disableTwoFactorAction,
  newBackupCodesAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  startTwoFactorAction,
} from "../account-actions";
import styles from "./page.module.css";

type Setup = { uri?: string; codes?: string[] };
const secretOf = (uri: string) => new URL(uri).searchParams.get("secret") ?? "";

// Password, two-factor (PRD 3.1) and signed-in devices. Reachable without 2FA
// set up, because this is where a company that requires it sends people.
export default async function Security(props: PageProps<"/settings/security">) {
  const { user, timeZone } = await requireMember(true);
  const sp = await props.searchParams;
  const [password, sessions, current] = await Promise.all([
    hasPassword(user.id),
    listMySessions(user.id),
    auth.api.getSession({ headers: await headers() }),
  ]);
  const raw = (await cookies()).get("nh_2fa_setup")?.value;
  const setup: Setup | null = raw ? JSON.parse(raw) : null;
  const showSetup = firstParam(sp.setup) === "1" && setup?.uri && !user.twoFactorEnabled;
  const showCodes = (showSetup || firstParam(sp.codes) === "1") && setup?.codes;
  const qr = showSetup ? await totpQrSvg(setup!.uri!) : null;

  return (
    <Page title="Security" error={firstParam(sp.error)} notice={firstParam(sp.notice)}>
      {firstParam(sp.required) === "1" && !user.twoFactorEnabled && (
        <p role="alert" className={styles.alert}>
          Your company requires two-factor authentication. Set it up below to keep using NotifyHub.
        </p>
      )}

      <Section title="Two-factor authentication">
        {user.twoFactorEnabled ? (
          <>
            <Hint>
              <Badge tone="success">On</Badge> Signing in with your password also asks for a code from your authenticator app.
            </Hint>
            {showCodes && <BackupCodes codes={setup!.codes!} />}
            <Form action={newBackupCodesAction}>
              <Field label="Password" name="password" type="password" autoComplete="current-password" required />
              <Button variant="secondary">Make new backup codes</Button>
            </Form>
            <Form action={disableTwoFactorAction}>
              <Field label="Password" name="password" type="password" autoComplete="current-password" required />
              <Button variant="danger">Turn off two-factor</Button>
            </Form>
          </>
        ) : showSetup ? (
          <>
            <Hint>1. Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), or type the key.</Hint>
            <div className={styles.qr} dangerouslySetInnerHTML={{ __html: qr! }} />
            <p className={styles.key}>
              Key: <code>{secretOf(setup!.uri!)}</code>
            </p>
            <BackupCodes codes={setup!.codes!} />
            <Form action={confirmTwoFactorAction}>
              <Field label="2. Enter the 6-digit code it shows" name="code" inputMode="numeric" autoComplete="one-time-code" required />
              <Button>Turn on two-factor</Button>
            </Form>
          </>
        ) : password ? (
          <Form action={startTwoFactorAction}>
            <Hint>Adds a code from an authenticator app to every password sign-in.</Hint>
            <Field label="Password" name="password" type="password" autoComplete="current-password" required />
            <Button>Set up two-factor</Button>
          </Form>
        ) : (
          <Hint>You sign in with Google, which has its own 2-step verification. Set a password first to add NotifyHub two-factor.</Hint>
        )}
      </Section>

      <Section title="Password">
        {password ? (
          <Form action={changePasswordAction}>
            <Field label="Current password" name="current" type="password" autoComplete="current-password" required />
            <Field label="New password" name="password" type="password" autoComplete="new-password" minLength={8} required />
            <Field label="Repeat the new password" name="confirm" type="password" autoComplete="new-password" minLength={8} required />
            <Button>Change password</Button>
            <Hint>This signs you out everywhere else.</Hint>
          </Form>
        ) : (
          <Hint>You sign in with Google, so there’s no NotifyHub password.</Hint>
        )}
      </Section>

      <Section title="Where you’re signed in">
        <Table
          columns={["Device", "IP", "Signed in", "Last active", ""]}
          rows={sessions.map((s) => ({
            key: s.id,
            cells: [
              <span key="d">
                {describeAgent(s.userAgent)} {s.token === current?.session.token && <Badge>This browser</Badge>}
              </span>,
              <Muted key="ip">{s.ipAddress || "—"}</Muted>,
              formatInZone(s.createdAt, timeZone),
              formatInZone(s.updatedAt, timeZone),
              s.token === current?.session.token ? (
                ""
              ) : (
                <form key="r" action={revokeSessionAction}>
                  <input type="hidden" name="sessionId" value={s.id} />
                  <Button variant="secondary" size="small">
                    Sign out
                  </Button>
                </form>
              ),
            ],
          }))}
        />
        {sessions.length > 1 && (
          <form action={revokeOtherSessionsAction} className={styles.others}>
            <Button variant="secondary">Sign out everywhere else</Button>
          </form>
        )}
      </Section>
    </Page>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div className={styles.codes}>
      <Hint>Backup codes: each works once if you lose your phone. Save them now; they won’t be shown again.</Hint>
      <ul>
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
