import { NextResponse } from "next/server";
import { forgeMarketRoutes, publicKitDetailResponseSchema } from "@agentkitforge/contracts";

type RouteContext = {
  params: Promise<{ slug?: string }>;
};

// PUBLIC route (no auth): Forge calls this for update checks, which must work
// without a token. Unlike the download/upload/validate routes, this returns
// read-only public catalog data and therefore intentionally does NOT call
// requireForgeUser(). It proxies the backend's public kit-detail route
// (GET {API_BASE_URL}/kits/{slug} → { item }), which uses no admin key.
export async function GET(_request: Request, { params }: RouteContext) {
  // Reference the contract route as this proxy's own path for consistency.
  void forgeMarketRoutes.kitDetail;

  let slug: string | undefined;

  try {
    slug = (await params).slug;

    if (!slug) {
      return NextResponse.json({ message: "Missing kit slug." }, { status: 400 });
    }

    const apiBaseUrl = process.env.NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL?.replace(/\/+$/, "");
    if (!apiBaseUrl) {
      logKitDetailFailure({ slug, backendStatus: null, reason: "server-config" });
      return NextResponse.json({ message: "Kit detail service is unavailable." }, { status: 502 });
    }

    const backendPath = `/kits/${encodeURIComponent(slug)}`;
    const backendResponse = await fetch(`${apiBaseUrl}${backendPath}`, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });

    if (backendResponse.status === 404) {
      return NextResponse.json({ message: "Kit not found" }, { status: 404 });
    }

    if (!backendResponse.ok) {
      logKitDetailFailure({ slug, backendStatus: backendResponse.status, reason: "backend-error" });
      return NextResponse.json({ message: "Kit detail service is unavailable." }, { status: 502 });
    }

    const bodyText = await backendResponse.text();
    const payload = parseBackendJson(bodyText);

    if (!payload) {
      logKitDetailFailure({ slug, backendStatus: backendResponse.status, reason: "invalid-json" });
      return NextResponse.json({ message: "Kit detail service is unavailable." }, { status: 502 });
    }

    const parsed = publicKitDetailResponseSchema.safeParse(payload);
    if (!parsed.success) {
      logKitDetailFailure({ slug, backendStatus: backendResponse.status, reason: "schema-mismatch" });
      return NextResponse.json({ message: "Kit detail service is unavailable." }, { status: 502 });
    }

    return NextResponse.json({ item: parsed.data.item }, { status: 200 });
  } catch (error) {
    logKitDetailFailure({
      slug,
      backendStatus: null,
      reason: "backend-unavailable",
      detail: error instanceof Error ? error.message : String(error)
    });
    return NextResponse.json({ message: "Kit detail service is unavailable." }, { status: 502 });
  }
}

function parseBackendJson(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
}

function logKitDetailFailure({
  slug,
  backendStatus,
  reason,
  detail
}: {
  slug?: string;
  backendStatus: number | null;
  reason: string;
  detail?: string;
}) {
  console.error("[agentkitmarket] forge kit-detail proxy failure", {
    slug: slug ?? null,
    backendStatus,
    reason,
    detail
  });
}
