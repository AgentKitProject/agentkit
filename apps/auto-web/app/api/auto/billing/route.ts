// /api/auto/billing — the user's Auto v2 billing snapshot (BROWSER / cookie auth).
//
// Auth: AuthKit cookie session (requireUserForApi) — NEVER the forge bearer
// (CLAUDE.md hard rule #4). Read-only.
//
//   GET → { metered, balanceCents, freeMinutesRemaining, freeMinutesPerMonth,
//           invocationFeeCents, activeMinuteRateCents }
//
// The UI uses this to surface the user's prepaid credit balance + remaining free
// active-minutes this month and to decide whether to show the buy-credits
// affordance. On a FREE self-host the snapshot reports `metered: false` (runs are
// unmetered) so the UI hides the credits UI. getBillingSummary ensureAccount's so
// a BYO user who never topped up still resolves a 0 balance (and gets an account
// row ready for their first run's charge).
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { getBillingSummary } from "@/server/core/auto";

export const dynamic = "force-dynamic";

export async function GET() {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  // A billing-read failure must not hard-fail the Auto page load. Degrade to an
  // unmetered (no-affordance) snapshot and log for observability instead of 500.
  try {
    const summary = await getBillingSummary(userId);
    return Response.json(summary, { status: 200 });
  } catch (error) {
    console.error("[auto] getBillingSummary failed", error);
    return Response.json(
      {
        metered: false,
        balanceCents: 0,
        freeMinutesRemaining: 0,
        freeMinutesPerMonth: 0,
        invocationFeeCents: 0,
        activeMinuteRateCents: 0
      },
      { status: 200 }
    );
  }
}
