// /api/auto/run-budget — the user's DEFAULT per-run budget (BROWSER / cookie auth).
//
// Auth: AuthKit cookie session (requireUserForApi) — NEVER the forge bearer
// (CLAUDE.md hard rule #4). Mirrors /api/auto/ai-providers.
//
//   GET → { userDefaultCents, effectiveCents, systemFallbackCents }
//         - userDefaultCents: the user's own default, or null if unset.
//         - effectiveCents: the resolved budget that a run would use right now
//           (org override → user default → system fallback). The org override is
//           resolved fails-open via Market, so this never errors on outage.
//   PUT → set the user's own default. Body: { budgetCents }.
//
// There is no per-run budget input anymore: runs/schedules/webhooks/approvals use
// the resolved budget, and the per-run cutoff enforces it automatically.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import {
  SYSTEM_DEFAULT_RUN_BUDGET_CENTS,
  getUserDefaultRunBudgetCents,
  resolveRunBudgetCents,
  setUserDefaultRunBudgetCents
} from "@/server/core/run-budget";

export const dynamic = "force-dynamic";

async function userIdOr401(): Promise<{ userId: string } | { response: Response }> {
  try {
    return { userId: (await requireUserForApi()).id };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { response: Response.json({ error: error.message }, { status: 401 }) };
    }
    throw error;
  }
}

function badRequest(message: string): Response {
  return Response.json(
    { error: autoErrorCodeSchema.enum.invalid_request, message },
    { status: 400 }
  );
}

export async function GET() {
  const auth = await userIdOr401();
  if ("response" in auth) return auth.response;
  const [userDefaultCents, effectiveCents] = await Promise.all([
    getUserDefaultRunBudgetCents(auth.userId),
    resolveRunBudgetCents(auth.userId)
  ]);
  return Response.json(
    {
      userDefaultCents: userDefaultCents ?? null,
      effectiveCents,
      systemFallbackCents: SYSTEM_DEFAULT_RUN_BUDGET_CENTS
    },
    { status: 200 }
  );
}

export async function PUT(request: Request) {
  const auth = await userIdOr401();
  if ("response" in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as { budgetCents?: unknown };
  const budgetCents = typeof body.budgetCents === "number" ? body.budgetCents : NaN;
  if (!Number.isInteger(budgetCents) || budgetCents <= 0) {
    return badRequest("budgetCents must be a positive integer (US cents).");
  }

  await setUserDefaultRunBudgetCents(auth.userId, budgetCents);

  const effectiveCents = await resolveRunBudgetCents(auth.userId);
  return Response.json(
    { userDefaultCents: budgetCents, effectiveCents, systemFallbackCents: SYSTEM_DEFAULT_RUN_BUDGET_CENTS },
    { status: 200 }
  );
}
