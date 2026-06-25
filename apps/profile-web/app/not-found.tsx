import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-73px)] max-w-3xl flex-col justify-center px-5 py-12">
      <p className="text-sm font-semibold uppercase tracking-wide text-[var(--brand)]">Not found</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-normal text-slate-950">
        This AgentKitProject page does not exist.
      </h1>
      <p className="mt-4 text-base leading-7 text-[var(--muted)]">
        The account app is available, but the route you requested is not part of AgentKitProfile.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link className="rounded-md bg-[var(--brand)] px-5 py-3 text-sm font-semibold text-white hover:bg-[var(--brand-strong)]" href="/">
          Go home
        </Link>
        <Link className="rounded-md border border-[var(--line)] bg-white px-5 py-3 text-sm font-semibold text-slate-900 hover:border-slate-400" href="/account">
          Account
        </Link>
      </div>
    </main>
  );
}
