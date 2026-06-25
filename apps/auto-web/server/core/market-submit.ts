// Hosted-Market submit, server-side. Materializes the user's kit tree into a
// temp dir, then runs the core market client's `submitKit` against it,
// authenticating with the user's WorkOS access token (from the AuthKit cookie
// session) forwarded as the Bearer token to Market's /api/forge/* routes.
//
// No automatic publishing: submitKit only sends to the review queue (CLAUDE.md
// hard rule #6). The temp dir is always cleaned up.
import { loadCoreMarket } from "@/server/core/load-core";
import { withMaterializedKit } from "@/server/core/runner";
import { createSessionTokenStore, workosClientId } from "@/server/core/market-auth";
import type { ListingDraft } from "@agentkitforge/core/market";

export type SubmitInput = {
  kitId: string;
  marketBaseUrl?: string;
  listingDraft?: Partial<ListingDraft>;
  fileName?: string;
};

export async function submitKitToMarket(userId: string, input: SubmitInput) {
  const market = await loadCoreMarket();
  // Seed a TokenStore from the live cookie-session WorkOS access token.
  const store = await createSessionTokenStore();
  return withMaterializedKit(userId, input.kitId, async ({ kitRoot }) => {
    const result = await market.submitKit(store, {
      rootPath: kitRoot,
      marketBaseUrl: input.marketBaseUrl ?? process.env.AGENTKITMARKET_BASE_URL,
      clientId: workosClientId(),
      listingDraft: input.listingDraft,
      fileName: input.fileName
    });
    return {
      submissionId: result.submissionId,
      status: result.status,
      marketLink: result.marketLink,
      sha256: result.sha256,
      validationReport: result.validationReport
    };
  });
}
