import Link from "next/link";

export function CatalogUnavailable({
  message = "The marketplace catalog could not load. Check the API configuration or try again in a moment.",
  title = "Backend unavailable"
}: {
  message?: string;
  title?: string;
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{message}</p>
      <Link className="ghost-button" href="/docs/market">
        View docs
      </Link>
    </div>
  );
}

export function EmptyCatalog() {
  return (
    <div className="empty-state">
      <strong>No kits available yet</strong>
      <p>The public catalog is connected, but there are no published, validated, and approved listings to show right now.</p>
    </div>
  );
}
