import { SecurityView } from "../../(app)/settings/security/security-view";

// Two-factor, password and sessions without the company app around it, for
// people who belong to no company (platform owners).
export default function AccountSecurity(props: PageProps<"/account/security">) {
  return <SecurityView base="/account/security" searchParams={props.searchParams} />;
}
