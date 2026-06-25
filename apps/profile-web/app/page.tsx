import { Button, Card } from "@agentkitforge/ui";

export default function Home() {
  return (
    <div className="mx-auto grid min-h-[calc(100vh-73px)] max-w-6xl items-center gap-10 px-5 py-12 lg:grid-cols-[1.1fr_0.9fr]">
      <section>
        <p className="text-sm font-semibold uppercase tracking-wide text-[var(--brand)]">
          AgentKitProject account
        </p>
        <h1 className="mt-4 max-w-3xl text-5xl font-semibold tracking-normal text-slate-950">
          Manage your AgentKitProject profile
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-[var(--muted)]">
          One account for AgentKitProject products, beginning with AgentKitMarket and ready for Forge and Auto as they connect.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button href="/auth/sign-in?returnTo=/account">
            Sign in with AgentKitProject
          </Button>
          <Button variant="secondary" href="/auth/sign-in?mode=sign-up&returnTo=/account">
            Create account
          </Button>
          <Button variant="ghost" href="/account">
            Go to account
          </Button>
        </div>
      </section>
      <Card>
        <p className="text-sm font-semibold text-[var(--brand)]">
          AgentKitProject identity
        </p>
        <dl className="mt-5 grid gap-4 text-sm">
          <div>
            <dt className="font-semibold text-slate-950">Account home</dt>
            <dd className="mt-1 text-[var(--muted)]">Profile, security, and product access live here.</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-950">Product boundary</dt>
            <dd className="mt-1 text-[var(--muted)]">Marketplace submissions, reviews, publishing, and downloads stay in AgentKitMarket.</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
