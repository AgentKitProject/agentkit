// RETIRED (P2). AgentKitProfile is now the system of record for org entities, so
// Auto resolves the user's effective ORG default run budget by calling
// AgentKitProfile DIRECTLY (PROFILE_API_BASE_URL + x-profile-service-key →
// `profileOrgRoutes.resolveUserOrgRunBudget`). This market-web two-hop service
// proxy is no longer on any path; it responds 410 Gone so a stale caller fails
// fast (and — because the resolver fails OPEN — degrades to the user's own default
// rather than failing a run).
export const dynamic = "force-dynamic";

const GONE_BODY = {
  error: "gone",
  message:
    "This route was retired in P2. Resolve org run budgets via AgentKitProfile (profileOrgRoutes.resolveUserOrgRunBudget)."
} as const;

export async function POST() {
  return Response.json(GONE_BODY, { status: 410 });
}
