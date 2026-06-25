import { CatalogUnavailable, EmptyCatalog } from "@/components/CatalogStatus";
import { CatalogExplorer } from "@/components/CatalogExplorer";
import { PageShell } from "@/components/PageShell";
import { listKits } from "@/lib/market-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function KitsPage({
  searchParams
}: {
  searchParams: Promise<{ category?: string; tag?: string }>;
}) {
  const params = await searchParams;
  const catalog = await listKits().then(
    (kits) => ({ kits, error: false, message: undefined as string | undefined }),
    (error) => ({
      kits: [],
      error: true,
      message: error instanceof Error ? error.message : "The marketplace catalog could not load."
    })
  );
  const kits = catalog.kits;

  return (
    <PageShell eyebrow="Public catalog" title="Published Agent Kits">
      <div className="rule-callout">
        <strong>Public listing rule</strong>
        <span>Only kits published by the backend after passed validation and admin approval appear in this catalog.</span>
      </div>
      {catalog.error ? (
        <CatalogUnavailable
          message={catalog.message ?? "The marketplace catalog could not load. Try refreshing in a moment."}
          title="Catalog unavailable"
        />
      ) : kits.length > 0 ? (
        <CatalogExplorer initialCategory={params.category ?? "all"} initialTag={params.tag ?? "all"} kits={kits} />
      ) : (
        <EmptyCatalog />
      )}
    </PageShell>
  );
}
