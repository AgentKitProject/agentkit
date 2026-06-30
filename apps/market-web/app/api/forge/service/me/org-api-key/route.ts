// RETIRED (P2). AgentKitProfile is now the system of record for org entities, so
// Auto / Web-Forge resolve the user's effective ORG shared API key by calling
// AgentKitProfile DIRECTLY (PROFILE_API_BASE_URL + x-profile-service-key →
// `profileOrgRoutes.resolveUserOrgApiKey`). This market-web two-hop service proxy
// is no longer on any path; it responds 410 Gone so a stale caller fails fast (and
// — because the resolvers fail OPEN — degrades to the operator/platform key rather
// than failing a run).
export const dynamic = "force-dynamic";

const GONE_BODY = {
  error: "gone",
  message:
    "This route was retired in P2. Resolve org API keys via AgentKitProfile (profileOrgRoutes.resolveUserOrgApiKey)."
} as const;

export async function POST() {
  return Response.json(GONE_BODY, { status: 410 });
}
