import Link from "next/link";
import { notFound } from "next/navigation";
import { CatalogUnavailable } from "@/components/CatalogStatus";
import { KitCard } from "@/components/KitCard";
import { PageShell } from "@/components/PageShell";
import { listKits } from "@/lib/market-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function PublisherPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const catalog = await listKits().then(
    (kits) => ({ kits, error: false }),
    () => ({ kits: [], error: true })
  );
  const kits = catalog.kits;
  const publisherKits = kits.filter((kit) => kit.publisher.slug === slug);
  const publisher = publisherKits[0]?.publisher;

  if (catalog.error) {
    return (
      <PageShell eyebrow="Publisher profile" title="Publisher unavailable">
        <CatalogUnavailable />
      </PageShell>
    );
  }

  if (!publisher) {
    notFound();
  }

  return (
    <PageShell
      eyebrow={publisher.verified ? "Verified publisher" : "Publisher profile"}
      title={publisher.name}
      actions={<Link className="ghost-button" href="/publish">Publisher tools</Link>}
    >
      <div className="publisher-hero">
        <div>
          <span className="section-label">Publisher</span>
          <p>{publisher.summary ?? "Public publisher details will appear here as the backend catalog grows."}</p>
        </div>
        <div className="trust-meter">
          <strong>{publisher.verified ? "Verified Publisher" : "Verification pending"}</strong>
          <span>
            {publisherKits.length} public kit{publisherKits.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      <div className="kit-grid">
        {publisherKits.map((kit) => (
          <KitCard key={kit.slug} kit={kit} />
        ))}
      </div>
    </PageShell>
  );
}
