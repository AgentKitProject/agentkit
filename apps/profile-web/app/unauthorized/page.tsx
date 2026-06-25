import { Button } from "@agentkitforge/ui";

export default function UnauthorizedPage() {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-73px)] max-w-3xl flex-col justify-center px-5 py-12">
      <p className="text-sm font-semibold uppercase tracking-wide text-[var(--brand)]">Unauthorized</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-normal text-slate-950">This account does not have access.</h1>
      <p className="mt-4 text-base leading-7 text-[var(--muted)]">
        Your AgentKitProject account is signed in, but the requested area requires an admin or owner role.
      </p>
      <Button className="mt-8 w-fit" href="/account">
        Return to account
      </Button>
    </div>
  );
}
