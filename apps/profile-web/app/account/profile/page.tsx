import { AccountShell } from "@/components/AccountShell";
import { InfoPanel } from "@/components/InfoPanel";
import { ProfileEditor } from "@/components/ProfileEditor";
import { requireUser } from "@/lib/auth/session";

export default async function ProfilePage() {
  await requireUser("/account/profile");

  return (
    <AccountShell title="Your AgentKitProject profile">
      <InfoPanel>
        <ProfileEditor />
      </InfoPanel>
    </AccountShell>
  );
}
