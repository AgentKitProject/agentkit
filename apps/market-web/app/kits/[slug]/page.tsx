import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, TrustBadge } from "@/components/Badge";
import { CatalogUnavailable } from "@/components/CatalogStatus";
import { ChecksumCopy } from "@/components/ChecksumCopy";
import { KitDownloadButton } from "@/components/KitDownloadButton";
import { CommercialAcquire } from "@/components/CommercialAcquire";
import { LicenseDisclosure } from "@/components/LicenseDisclosure";
import { OpenInForgeButton } from "@/components/OpenInForgeButton";
import { canDownloadKit, getCurrentUser, isAdminEmail } from "@/lib/auth";
import { getMarketBaseUrl } from "@/lib/forge-link";
import { getKitBySlug, isPublicCatalogKit } from "@/lib/market-api";
import { effectiveLicenseText, effectiveLicenseVersion, priceLabel } from "@/lib/kit-license";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  try {
    const { slug } = await params;
    const kit = await getKitBySlug(slug);
    if (!kit) return { title: "Kit — AgentKitMarket" };
    return {
      title: `${kit.name} — AgentKitMarket`,
      description: kit.summary ?? kit.description ?? "An Agent Kit on AgentKitMarket.",
      alternates: { canonical: `/kits/${slug}` },
      openGraph: {
        title: kit.name,
        description: kit.summary ?? kit.description ?? "An Agent Kit on AgentKitMarket.",
        type: "website",
      },
    };
  } catch {
    return { title: "Kit — AgentKitMarket" };
  }
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function KitDetailPage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await getCurrentUser();
  const result = await getKitBySlug(slug).then(
    (kit) => ({ kit, error: false, message: undefined as string | undefined }),
    (error) => ({
      kit: null,
      error: true,
      message: error instanceof Error ? error.message : "The kit detail API could not load this listing."
    })
  );
  const kit = result.kit;

  if (result.error) {
    return (
      <section className="content-band">
        <CatalogUnavailable
          message={result.message ?? "The kit detail API could not load this listing. Try refreshing this kit page in a moment."}
          title="Kit detail unavailable"
        />
      </section>
    );
  }

  if (!kit) {
    notFound();
  }

  if (kit.status && !isPublicCatalogKit(kit)) {
    notFound();
  }

  const description = kit.description ?? kit.summary;
  const outcomes = kit.outcomes ?? [];
  const version = kit.currentVersion ?? "Version pending";
  const packageMetadata = kit.packageMetadata ?? {};
  const packageFileName = packageMetadata.fileName ?? fallbackPackageFileName(slug, kit.currentVersion);
  const marketBaseUrl = getMarketBaseUrl();

  const isPaid = kit.pricing === "paid";
  // Paid kits are online-only unless explicitly enabled; free kits are downloadable.
  const isDownloadable = isPaid ? kit.downloadable === true : true;
  const price = priceLabel({
    pricing: kit.pricing,
    priceModel: kit.priceModel,
    priceCents: kit.priceCents,
    currency: kit.currency,
    interval: kit.interval
  });
  const isCustomLicense = kit.licenseType === "custom";
  const licenseText = effectiveLicenseText({ licenseType: kit.licenseType, licenseText: kit.licenseText });
  const licenseLabel = isCustomLicense
    ? "This kit is offered under a custom publisher license."
    : "This kit is offered under the AgentKitProject Standard Kit License (default-v1).";
  const userIsAdmin = Boolean(user?.email && isAdminEmail(user.email));

  return (
    <section className="detail-layout">
      <div className="detail-main">
        <p className="eyebrow">Agent Kit listing</p>
        <h1>{kit.name}</h1>
        <p className="detail-summary">{description}</p>
        <div className="badge-row">
          <Badge tone="teal">{price}</Badge>
          {isPaid && !isDownloadable ? <Badge>Online-only</Badge> : null}
          <Badge>{isCustomLicense ? "Custom license" : "Licensed"}</Badge>
          {kit.trustBadges.map((status) => (
            <TrustBadge key={status} status={status} />
          ))}
        </div>

        {outcomes.length > 0 ? (
          <div className="detail-panel">
            <h2>What this kit provides</h2>
            <div className="summary-list">
              {outcomes.map((outcome) => (
                <span key={outcome}>{outcome}</span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="detail-panel">
          <h2>Prepared prompt summaries</h2>
          <p className="privacy-note">Summaries are shown publicly. Full prompt text is available only after import.</p>
          {kit.preparedPrompts.length > 0 ? (
            <ul>
              {kit.preparedPrompts.map((prompt) => (
                <li key={prompt.name}>
                  <strong>{prompt.name}</strong>
                  {prompt.summary ? `: ${prompt.summary}` : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>No public prepared prompt summaries are available yet.</p>
          )}
        </div>

        <div className="detail-panel">
          <h2>Skill summaries</h2>
          <p className="privacy-note">Skill markdown and raw kit files are intentionally hidden from public listings.</p>
          {kit.skills.length > 0 ? (
            <ul>
              {kit.skills.map((skill) => (
                <li key={skill.name}>
                  <strong>{skill.name}</strong>
                  {skill.summary ? `: ${skill.summary}` : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>No public skill summaries are available yet.</p>
          )}
        </div>

        {kit.versionMetadata ? (
          <div className="detail-panel">
            <h2>Version metadata</h2>
            <dl className="metadata-list">
              {Object.entries(kit.versionMetadata).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        {kit.validationSummary ? (
          <div className="detail-panel">
            <h2>Validation summary</h2>
            {kit.validationSummary.message ? <p>{kit.validationSummary.message}</p> : null}
            {kit.validationSummary.checks.length > 0 ? (
              <ul>
                {kit.validationSummary.checks.map((check) => (
                  <li key={`${check.name}-${check.status}`}>
                    <strong>{check.name}</strong>
                    {`: ${check.status}`}
                    {check.summary ? ` - ${check.summary}` : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Public validation details are not available yet.</p>
            )}
          </div>
        ) : null}

        <LicenseDisclosure licenseText={licenseText} licenseLabel={licenseLabel} />
      </div>

      <aside className="detail-sidebar">
        <div className="sidebar-card">
          <span className="section-label">Publisher</span>
          <div className="publisher-lockup">
            <span className="kit-icon" aria-hidden="true">
              {kit.publisher.initials}
            </span>
            <Link href={`/publishers/${kit.publisher.slug}`}>{kit.publisher.name}</Link>
          </div>
        </div>
        <div className="sidebar-card">
          <span className="section-label">Version</span>
          <strong>{version}</strong>
          <span>{kit.updatedAt ? `Updated ${formatDate(kit.updatedAt)}` : "Updated date pending"}</span>
        </div>
        <div className="sidebar-card">
          <span className="section-label">Required inputs</span>
          {kit.requiredInputs.length > 0 ? (
            <ul>
              {kit.requiredInputs.map((input) => (
                <li key={input.name}>
                  <strong>{input.name}</strong>
                  {input.summary ? `: ${input.summary}` : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>No public input summary yet.</p>
          )}
        </div>
        <div className="sidebar-card">
          <span className="section-label">Tags</span>
          <div className="chip-row">
            {kit.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        </div>
        <div className="sidebar-card download-panel">
          <div>
            <span className="section-label">{isPaid ? "Pricing" : "Download / Import"}</span>
            <h2>{isPaid ? price : "Download package"}</h2>
            <p className="privacy-note">
              {isPaid && !isDownloadable
                ? "This kit is online-only — use it in AgentKitForge after acquiring."
                : "Downloads require an AgentKitProject account."}
            </p>
          </div>
          <dl className="metadata-list compact-metadata">
            <div>
              <dt>Version</dt>
              <dd>{version}</dd>
            </div>
            <div>
              <dt>Filename</dt>
              <dd>{packageFileName}</dd>
            </div>
            {packageMetadata.packageSizeBytes !== undefined ? (
              <div>
                <dt>Size</dt>
                <dd>{formatBytes(packageMetadata.packageSizeBytes)}</dd>
              </div>
            ) : null}
            <div>
              <dt>Published</dt>
              <dd>{packageMetadata.publishedAt ? formatDate(packageMetadata.publishedAt) : "Publication date pending"}</dd>
            </div>
            {packageMetadata.sha256 ? (
              <div>
                <dt>SHA-256</dt>
                <dd>
                  <ChecksumCopy value={packageMetadata.sha256} />
                </dd>
              </div>
            ) : null}
          </dl>
          {!canDownloadKit(user) ? (
            <Link className="primary-button full-width" href={`/auth/sign-in?returnTo=${encodeURIComponent(`/kits/${slug}`)}`}>
              {isPaid ? `Sign in to buy ${price}` : "Sign in to download"}
            </Link>
          ) : isPaid ? (
            <CommercialAcquire
              slug={slug}
              priceText={price}
              pricing="paid"
              priceModel={kit.priceModel}
              trialDays={kit.trialDays}
              downloadable={isDownloadable}
              licenseText={licenseText}
              licenseVersion={effectiveLicenseVersion({ licenseType: kit.licenseType, licenseVersion: kit.licenseVersion })}
              isAdmin={userIsAdmin}
            />
          ) : (
            <KitDownloadButton slug={slug} />
          )}
          {isPaid ? (
            <p className="privacy-note">
              Already purchased? Find your downloads in{" "}
              <Link className="secondary-link" href="/purchases">
                My Purchases
              </Link>
              .
            </p>
          ) : null}
        </div>
        <div className="sidebar-card forge-panel">
          <span className="section-label">Import into AgentKitForge</span>
          <strong>Launch AgentKitForge and import this kit.</strong>
          <p>Forge handles authentication, download, and local import after launch.</p>
          <OpenInForgeButton marketBaseUrl={marketBaseUrl} slug={slug} />
          <p className="privacy-note">Manual download is also available for signed-in users.</p>
        </div>
        <div className="sidebar-card">
          <span className="section-label">Listing support</span>
          <strong>Report this listing</strong>
          <p>Abuse/reporting workflow coming soon. Contact support for now.</p>
          <a className="secondary-link" href={`mailto:support@agentkitproject.com?subject=${encodeURIComponent(`AgentKitMarket report: ${kit.name}`)}`}>
            Contact support
          </a>
        </div>
      </aside>
    </section>
  );
}

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function fallbackPackageFileName(slug: string, version?: string) {
  const safeSlug = slug.replace(/[^a-z0-9-]+/gi, "-").replace(/(^-|-$)/g, "") || "kit";
  const safeVersion = version?.replace(/[^a-z0-9._-]+/gi, "-").replace(/(^-|-$)/g, "") || "latest";
  return `agentkit-${safeSlug}-${safeVersion}.agentkit.zip`;
}
