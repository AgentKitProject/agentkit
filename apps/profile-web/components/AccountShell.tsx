import Link from "next/link";

const navItems = [
  { href: "/account", label: "Overview" },
  { href: "/account/profile", label: "Profile" },
  { href: "/account/security", label: "Security" },
  { href: "/account/products", label: "Products" },
];

export function AccountShell({
  title,
  eyebrow = "AgentKitProject account",
  children,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 md:grid-cols-[220px_1fr]">
      <aside>
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">{eyebrow}</p>
        <nav className="mt-4 grid gap-1 text-sm font-medium text-slate-700">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href} className="rounded-md px-3 py-2 hover:bg-white">
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <section>
        <h1 className="text-3xl font-semibold tracking-normal text-slate-950">{title}</h1>
        <div className="mt-6">{children}</div>
      </section>
    </div>
  );
}
