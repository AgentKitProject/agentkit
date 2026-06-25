// GET /api/me/credits -> the signed-in user's prepaid credit balance.
// { balanceCents, currency }. balanceCents is 0 when the user has no account
// yet (read-only; does not create the ledger row).
import { withUser } from "@/lib/api";
import { getBalanceCents, CREDITS_CURRENCY } from "@/server/core/gateway";
import { isManagedInferenceEnabled } from "@/lib/self-host";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser(async (user) => {
    // No prepaid-credit ledger on self-host (BYO-key only) — never touch Dynamo.
    if (!isManagedInferenceEnabled()) {
      return { balanceCents: 0, currency: CREDITS_CURRENCY, disabled: true };
    }
    const balanceCents = await getBalanceCents(user.id);
    return { balanceCents, currency: CREDITS_CURRENCY };
  });
}
