// GET /api/managed/models -> the managed (in-house, prepaid-credit) model list.
// Returns { models: [{ id, label, tier, provider }], defaultModel }. Used by the
// Auto run/schedule/webhook model selectors when a user is on managed inference
// (no BYO provider configured). Static catalog gated by runtime env.
import { MANAGED_MODELS, MANAGED_DEFAULT_MODEL } from "@/server/core/managed-models";
import { isManagedInferenceEnabled } from "@/lib/self-host";

// Dynamic: the response depends on runtime env (the gates below).
export const dynamic = "force-dynamic";

// Managed OpenAI (GPT) is offered only when the platform has provisioned it.
// Two signals so this works across the hosted split topology (the web pod may
// not itself hold the inference key — e.g. Forge inference runs in the gateway)
// AND self-host (the web pod holds the operator's own key):
//   - OPENAI_API_KEY present in the route's env, OR
//   - MANAGED_OPENAI_ENABLED=true (explicit deployment flag).
// Absent both, the GPT rows are filtered out so users never see a model that
// would fail with "OPENAI_API_KEY not configured".
function managedOpenAiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPENAI_API_KEY?.trim() ?? "") !== "" || env.MANAGED_OPENAI_ENABLED === "true";
}

export function GET() {
  // Self-host is BYO-key only — there is no managed model catalog to offer.
  if (!isManagedInferenceEnabled()) {
    return Response.json({ models: [], defaultModel: null, disabled: true });
  }
  const models = managedOpenAiEnabled()
    ? MANAGED_MODELS
    : MANAGED_MODELS.filter((m) => m.provider !== "openai");
  return Response.json({ models, defaultModel: MANAGED_DEFAULT_MODEL });
}
