import { redirect } from "next/navigation";
import { platformAccess } from "@/lib/platform";
import { SecurityView } from "../../(app)/settings/security/security-view";

// Two-factor, password and sessions for platform owners, inside the console.
// Owners without 2FA land here too: the console asks for it first.
export default async function PlatformSecurity(props: PageProps<"/platform/security">) {
  const a = await platformAccess();
  if (!("owner" in a) && a.reason !== "2fa") redirect("/platform/sign-in"); // the layout already 404s "no"
  return <SecurityView base="/platform/security" searchParams={props.searchParams} />;
}
