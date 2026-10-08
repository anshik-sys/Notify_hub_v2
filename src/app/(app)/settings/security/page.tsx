import { SecurityView } from "./security-view";

export default function Security(props: PageProps<"/settings/security">) {
  return <SecurityView base="/settings/security" searchParams={props.searchParams} />;
}
