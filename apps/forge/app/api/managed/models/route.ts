// GET /api/managed/models -> the managed (in-house, prepaid-credit) model list.
// Returns { models: [{ id, label, tier }], defaultModel }. Used by the Build
// generate/revise + Edit-with-AI selectors when a user is on managed inference
// (no BYO provider configured). Static catalog — no auth or I/O required.
import { MANAGED_MODELS, MANAGED_DEFAULT_MODEL } from "@/server/core/managed-models";
import { isManagedInferenceEnabled } from "@/lib/self-host";

// Dynamic: the response depends on runtime env (the self-host gate below).
export const dynamic = "force-dynamic";

export function GET() {
  // Self-host is BYO-key only — there is no managed model catalog to offer.
  if (!isManagedInferenceEnabled()) {
    return Response.json({ models: [], defaultModel: null, disabled: true });
  }
  return Response.json({ models: MANAGED_MODELS, defaultModel: MANAGED_DEFAULT_MODEL });
}
