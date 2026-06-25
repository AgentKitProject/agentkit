import Link from "next/link";
import { Badge, TrustBadge } from "@/components/Badge";
import type { MarketKitListItem } from "@/lib/market-api";
import { priceLabel } from "@/lib/kit-license";

export function KitCard({ kit }: { kit: MarketKitListItem }) {
  const version = kit.currentVersion ? `v${kit.currentVersion}` : "Version pending";
  const requiredInputs =
    kit.requiredInputs.length > 0 ? kit.requiredInputs.map((input) => input.name).join(", ") : "No public input summary yet";
  const isPaid = kit.pricing === "paid";
  const isOnlineOnly = isPaid && kit.downloadable !== true;
  const price = priceLabel({
    pricing: kit.pricing,
    priceModel: kit.priceModel,
    priceCents: kit.priceCents,
    currency: kit.currency,
    interval: kit.interval
  });

  return (
    <article className="kit-card">
      <div className="kit-card-topline">
        <div className="kit-icon" aria-hidden="true">
          {kit.publisher.initials}
        </div>
        <div className="kit-card-meta">
          <Link href={`/publishers/${kit.publisher.slug}`}>{kit.publisher.name}</Link>
          <span>{version}</span>
        </div>
      </div>
      <div>
        <h3>
          <Link href={`/kits/${kit.slug}`}>{kit.name}</Link>
        </h3>
        <p>{kit.summary}</p>
      </div>
      <div className="badge-row">
        <Badge tone="teal">{price}</Badge>
        {isOnlineOnly ? <Badge>Online-only</Badge> : null}
        {kit.trustBadges.map((status) => (
          <TrustBadge key={status} status={status} />
        ))}
      </div>
      <div className="card-section">
        <span className="section-label">Requires</span>
        <p>{requiredInputs}</p>
      </div>
      {kit.categories.length > 0 ? (
        <div className="card-section compact-card-section">
          <span className="section-label">Categories</span>
          <div className="chip-row">
            {kit.categories.slice(0, 2).map((category) => (
              <Badge key={category}>{category}</Badge>
            ))}
          </div>
        </div>
      ) : null}
      <div className="chip-row">
        {kit.tags.slice(0, 3).map((tag) => (
          <Badge key={tag}>{tag}</Badge>
        ))}
      </div>
      <div className="kit-card-footer">
        <span>{isPaid ? price : kit.importCountLabel ?? "Download gated"}</span>
        <Link className="secondary-link" href={`/kits/${kit.slug}`}>
          {isPaid ? `Buy ${price}` : "View listing"}
        </Link>
      </div>
    </article>
  );
}
