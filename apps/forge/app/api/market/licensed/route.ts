// POST /api/market/licensed -> fetchLicensedMarketKit
// body: { slug, kitId?, marketBaseUrl? }
//
// Tier-2 paid/licensed kits. Calls core's fetchLicensedKit server-side and
// builds an IN-MEMORY preview. Online-only kits are NEVER persisted to the
// KitStore — bytes stay in this process and are discarded. (Mirrors the desktop
// market-operation.mjs licensed-package path.)
//
// AUTH: seeds a TokenStore from the user's WorkOS access token (AuthKit cookie
// session, forwarded as the Bearer token) so entitlement checks pass for
// licensed/private kits; degrades to tokenless for public metadata previews.
import { withUser } from "@/lib/api";
import { loadCoreMarket } from "@/server/core/load-core";
import { createForwardingStore } from "@/server/core/import-ops";
import { getEcosystemLinks, getMarketBaseUrl } from "@/lib/self-host";
import { ONLINE_ONLY_RUN_REQUIRED, type OnlineOnlyRunDirective } from "@agentkitforge/contracts";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MAX_PREVIEW_TEXT_BYTES = 64 * 1024;
const PREVIEW_TEXT_CANDIDATES = ["agentkit.yaml", "AGENTKIT.md", "START_HERE.md"];

async function buildInMemoryPreview(bytes: Uint8Array) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const files: string[] = [];
  zip.forEach((relativePath, entry) => {
    if (!entry.dir) files.push(relativePath);
  });
  files.sort();
  const texts: Record<string, string> = {};
  for (const name of PREVIEW_TEXT_CANDIDATES) {
    const entry = zip.file(name);
    if (!entry) continue;
    const content = await entry.async("string");
    texts[name] =
      content.length > MAX_PREVIEW_TEXT_BYTES ? `${content.slice(0, MAX_PREVIEW_TEXT_BYTES)}\n\n[Preview truncated]` : content;
  }
  return { files, texts };
}

export async function POST(request: Request) {
  return withUser(async () => {
    const body = (await request.json()) as { slug?: string; kitId?: string; marketBaseUrl?: string };
    if (!body.slug) throw new Error("slug is required.");
    // Resolve a Market URL: caller override → instance Market. With no Market
    // configured (self-host without a Market) refuse — never phone home.
    const marketBaseUrl = body.marketBaseUrl ?? getMarketBaseUrl();
    if (!marketBaseUrl) {
      return NextResponse.json(
        { error: "Market preview is not available on this instance." },
        { status: 404 }
      );
    }
    const market = await loadCoreMarket();
    const store = await createForwardingStore();

    // BELT-AND-SUSPENDERS (M6 Slice 1): this is a BROWSER (client) preview route —
    // it must NEVER build or return the CONTENT of a PROTECTED (online-only, paid &&
    // !downloadable) kit. Classify first (no bytes fetched); for a protected kit,
    // return the output-only run directive (HTTP 402) and never reach the
    // byte-fetch / preview build. Downloadable paid kits and free kits proceed as
    // before. This closes the leak at the route even before the commercial handler
    // (and core's defense-in-depth) deploy.
    const status = await market.checkEntitlement(store as never, {
      slug: body.slug,
      marketBaseUrl,
      clientId: process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID ?? ""
    });
    if (status.onlineOnly === true) {
      const links = getEcosystemLinks();
      const runTargets: OnlineOnlyRunDirective["runTargets"] = {
        ...(links.forgeUrl ? { forgeWebUrl: links.forgeUrl } : {}),
        ...(links.autoUrl ? { autoUrl: links.autoUrl } : {})
      };
      const directive: OnlineOnlyRunDirective = {
        onlineOnly: true,
        code: ONLINE_ONLY_RUN_REQUIRED,
        slug: body.slug,
        ...(status.kitId ? { kitId: status.kitId } : {}),
        message: "This kit is output-only — run it on Forge or Auto.",
        ...(runTargets.forgeWebUrl || runTargets.autoUrl ? { runTargets } : {})
      };
      return NextResponse.json(directive, { status: 402, headers: { "Cache-Control": "no-store" } });
    }

    const licensed = await market.fetchLicensedKit(store as never, {
      slug: body.slug,
      marketBaseUrl,
      clientId: process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID ?? ""
    });
    const preview = await buildInMemoryPreview(licensed.bytes);
    // ONLINE-ONLY: never persist; only preview. DOWNLOADABLE: the web client can
    // re-fetch and download; we still do not write to the KitStore here.
    return {
      onlineOnly: licensed.onlineOnly === true,
      pricing: licensed.pricing,
      downloadable: licensed.downloadable === true,
      kitId: licensed.kitId,
      fileName: licensed.fileName,
      sha256: licensed.sha256,
      licenseVersion: licensed.licenseVersion,
      entitlementId: licensed.entitlementId,
      preview
    };
  });
}
