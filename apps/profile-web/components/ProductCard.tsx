import { Badge, Button, Card } from "@agentkitforge/ui";
import type { AgentKitProduct } from "@/lib/products";

export function ProductCard({ product }: { product: AgentKitProduct }) {
  const isAvailable = product.status === "available";

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold text-slate-950">{product.name}</h2>
        <Badge tone={isAvailable ? "success" : "neutral"}>
          {isAvailable ? "Available" : "Coming later"}
        </Badge>
      </div>
      <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{product.description}</p>
      {isAvailable ? (
        <Button className="mt-5" size="sm" href={product.href}>
          Open product
        </Button>
      ) : null}
    </Card>
  );
}
