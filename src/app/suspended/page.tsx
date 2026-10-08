import { Button, Hint, Page } from "@/components/form";
import { signOutAction } from "../(app)/settings/account-actions";

// PRD 9.2: what a suspended company's people see. Nothing else is reachable
// (requireMember sends them here); sends are paused by the worker too.
export default function Suspended() {
  return (
    <Page center title="Account suspended">
      <Hint>This company’s NotifyHub account is suspended. Nothing is being sent. Contact the NotifyHub team or your administrator.</Hint>
      <form action={signOutAction}>
        <Button variant="secondary">Sign out</Button>
      </form>
    </Page>
  );
}
