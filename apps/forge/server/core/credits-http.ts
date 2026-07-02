// Shared HTTP mapping for managed-credit errors.
//
// When a managed (prepaid-credit) inference turn cannot reserve its pre-call
// hold, gateway-core throws InsufficientCreditsError. We surface this as a
// 402 Payment Required with a machine-readable body so the UI can prompt a
// top-up inline rather than showing a generic 400.
import { NextResponse } from "next/server";
import { InsufficientCreditsError, getBalanceCents } from "@/server/core/gateway";

/**
 * If `error` is an InsufficientCreditsError, return a 402 NextResponse with
 * { code, message, requiredCents, balanceCents }. Otherwise returns null so the
 * caller rethrows (mapped by withUser()).
 */
export async function insufficientCreditsResponse(
  error: unknown,
  userId: string
): Promise<NextResponse | null> {
  if (!(error instanceof InsufficientCreditsError)) return null;
  // Prefer the balance the error captured; fall back to a fresh ledger read.
  const balanceCents =
    error.availableCents ?? (await getBalanceCents(userId).catch(() => 0));
  return NextResponse.json(
    {
      code: "insufficient_credits",
      message:
        "Not enough credits for managed AI. Add credits to keep generating, or configure your own AI provider in Settings.",
      requiredCents: error.requiredCents,
      balanceCents
    },
    { status: 402 }
  );
}
