import { getOrgStore } from "@/lib/store";
import { getOrgBySlugPublic } from "@/lib/profile-api/org-handlers";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

/**
 * GET /orgs/by-slug/{slug} — PUBLIC org shape by slug. Intentionally unauth (no
 * service key, no trusted-context): returns only the public subset of the org.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const result = await getOrgBySlugPublic(getOrgStore(), slug);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
