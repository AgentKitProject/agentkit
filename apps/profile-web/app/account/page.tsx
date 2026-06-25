import Link from "next/link";
import { AccountShell } from "@/components/AccountShell";
import { AccountProfileSummary } from "@/components/AccountProfileSummary";
import { InfoPanel } from "@/components/InfoPanel";
import { ProductCard } from "@/components/ProductCard";
import { requireUser } from "@/lib/auth/session";
import { products } from "@/lib/products";

export default async function AccountPage() {
  await requireUser("/account");

  return (
    <AccountShell title="Account overview">
      <div className="grid gap-6">
        <InfoPanel>
          <AccountProfileSummary />
        </InfoPanel>

        <div>
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl font-semibold text-slate-950">Products</h2>
            <Link className="text-sm font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]" href="/account/products">
              View all
            </Link>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {products.map((product) => (
              <ProductCard key={product.name} product={product} />
            ))}
          </div>
        </div>
      </div>
    </AccountShell>
  );
}
