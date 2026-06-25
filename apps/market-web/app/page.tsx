import Image from "next/image";
import Link from "next/link";
import { CatalogUnavailable } from "@/components/CatalogStatus";
import { KitCard } from "@/components/KitCard";
import { getCurrentUser } from "@/lib/auth";
import { listKits } from "@/lib/market-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const AGENTKIT_PROFILE_ACCOUNT_URL = "https://profile.agentkitproject.com/account";
const AGENTKIT_FORGE_URL = "https://forge.agentkitproject.com";

export default async function Home() {
  const user = await getCurrentUser();
  const catalog = await listKits().then(
    (kits) => ({ kits, error: false, message: undefined as string | undefined }),
    (error) => ({
      kits: [],
      error: true,
      message: error instanceof Error ? error.message : "The marketplace catalog could not load."
    })
  );
  const kits = catalog.kits;
  const featured = kits.filter((kit) => kit.trustBadges.includes("Featured")).slice(0, 3);
  const visibleKits = featured.length > 0 ? featured : kits.slice(0, 3);
  const categories = Array.from(new Set(kits.flatMap((kit) => kit.categories))).slice(0, 8);
  const tags = Array.from(new Set(kits.flatMap((kit) => kit.tags))).slice(0, 10);
  const submitHref = user ? "/submit" : `/auth/sign-in?returnTo=${encodeURIComponent("/submit")}`;

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <Image src="/brand/agentkitmarket-logo.svg" alt="AgentKitMarket" width={280} height={158} priority />
          <p className="eyebrow">AgentKitProject marketplace</p>
          <h1>Discover trusted Agent Kits for repeatable AI workflows.</h1>
          <p>
            AgentKitMarket is the public catalog for reusable Agent Kits: packaged prompts, skills, and input summaries
            that can be validated, reviewed, published, and downloaded without exposing raw kit internals.
          </p>
          <div className="hero-actions">
            <Link className="primary-button" href="/kits">
              Browse kits
            </Link>
            <Link className="ghost-button" href={submitHref}>
              Submit a kit
            </Link>
            <a className="ghost-button" href={AGENTKIT_PROFILE_ACCOUNT_URL}>
              AgentKitProject account
            </a>
          </div>
        </div>
        <div className="market-preview" aria-label="Marketplace trust overview">
          <div className="preview-header">
            <span>Public listing gate</span>
            <strong>Published + Passed + Approved</strong>
          </div>
          <div className="signal-grid">
            <span>Discovery</span>
            <span>Trusted listings</span>
            <span>Reusable kits</span>
            <span>Submission review</span>
          </div>
          <div className="preview-card">
            <span className="section-label">Import placeholder</span>
            <strong>AgentKitForge coming soon</strong>
            <p>Download approved .agentkit.zip packages today. Direct Forge import comes later.</p>
          </div>
        </div>
      </section>

      <section className="content-band">
        <div className="section-heading">
          <div>
            <p className="eyebrow">What is an Agent Kit?</p>
            <h2>Reusable workflow packages, shown safely.</h2>
          </div>
        </div>
        <div className="info-grid">
          <div className="flow-card">
            <h3>Prepared prompts</h3>
            <p>Public listings show summaries so users understand the workflow without copying the kit.</p>
          </div>
          <div className="flow-card">
            <h3>Skills and inputs</h3>
            <p>Required inputs and skill summaries help people decide whether a kit fits their task.</p>
          </div>
          <div className="flow-card">
            <h3>Private packages</h3>
            <p>Raw packages stay private and downloads use short-lived URLs for signed-in users.</p>
          </div>
        </div>
      </section>

      <section className="content-band">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Featured catalog</p>
            <h2>Published kits ready for discovery</h2>
          </div>
          <Link className="secondary-link" href="/kits">
            View all kits
          </Link>
        </div>
        {catalog.error ? (
          <CatalogUnavailable message={catalog.message} title="Catalog preview unavailable" />
        ) : visibleKits.length > 0 ? (
          <div className="kit-grid">
            {visibleKits.map((kit) => (
              <KitCard key={kit.slug} kit={kit} />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <strong>No public kits available yet</strong>
            <p>The backend is connected, but the public catalog has no published, validated, and approved kits yet.</p>
          </div>
        )}
      </section>

      {categories.length > 0 || tags.length > 0 ? (
        <section className="content-band">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Explore</p>
              <h2>Start with a category or tag</h2>
            </div>
          </div>
          <div className="entrypoint-panel">
            {categories.length > 0 ? (
              <div>
                <h3>Categories</h3>
                <div className="chip-row">
                  {categories.map((category) => (
                    <Link className="filter-chip" href={`/kits?category=${encodeURIComponent(category)}`} key={category}>
                      {category}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
            {tags.length > 0 ? (
              <div>
                <h3>Tags</h3>
                <div className="chip-row">
                  {tags.map((tag) => (
                    <Link className="filter-chip" href={`/kits?tag=${encodeURIComponent(tag)}`} key={tag}>
                      {tag}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="content-band">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Trust and safety</p>
            <h2>Public listings are gated.</h2>
          </div>
        </div>
        <div className="info-grid">
          <div className="flow-card">
            <h3>Validated packages</h3>
            <p>Public kits must pass backend validation before they can be reviewed for publication.</p>
          </div>
          <div className="flow-card">
            <h3>Admin-reviewed listings</h3>
            <p>Admins approve public-safe metadata before a kit appears in the catalog.</p>
          </div>
          <div className="flow-card">
            <h3>Report a listing</h3>
            <p>Abuse/reporting workflow coming soon. Contact support for now.</p>
            <a className="secondary-link" href="mailto:support@agentkitproject.com?subject=AgentKitMarket%20listing%20report">
              Report this listing
            </a>
          </div>
        </div>
        <div className="rule-callout">
          <strong>AgentKitForge</strong>
          <span>Soon you&apos;ll be able to open approved kits directly in AgentKitForge.</span>
          <a className="secondary-link" href={AGENTKIT_FORGE_URL}>
            Forge placeholder
          </a>
        </div>
      </section>
    </>
  );
}
