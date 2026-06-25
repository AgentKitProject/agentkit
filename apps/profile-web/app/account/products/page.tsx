import { AccountShell } from "@/components/AccountShell";
import { ProductCard } from "@/components/ProductCard";
import { requireUser } from "@/lib/auth/session";
import { products } from "@/lib/products";

export default async function ProductsPage() {
  await requireUser("/account/products");

  return (
    <AccountShell title="Products">
      <div className="grid gap-4 md:grid-cols-3">
        {products.map((product) => (
          <ProductCard key={product.name} product={product} />
        ))}
      </div>
    </AccountShell>
  );
}
