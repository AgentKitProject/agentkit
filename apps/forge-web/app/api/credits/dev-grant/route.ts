// POST /api/credits/dev-grant -> DEV/ADMIN-ONLY prepaid credit grant.
//
// This is a TESTING affordance used BEFORE the Stripe top-up flow exists
// (Gateway 1b-ii). It lets an allowlisted admin fund their own (or another
// user's) credit balance so managed inference can be exercised end-to-end.
//
// Gating: the caller's AuthKit email must appear in ADMIN_EMAILS (comma-sep,
// case-insensitive). Non-admins get 403. There is NO public top-up here.
//
// body (all optional): { amountCents?: number (default 500, max 10000),
//                        targetUserId?: string (default the caller) }
import { withUser, jsonError } from "@/lib/api";
import { devGrantCredits, CREDITS_CURRENCY } from "@/server/core/gateway";

export const dynamic = "force-dynamic";

const DEFAULT_GRANT_CENTS = 500; // $5.00
const MAX_GRANT_CENTS = 10_000; // $100.00 safety ceiling for the dev route.

function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

export async function POST(request: Request) {
  return withUser(async (user) => {
    const allow = adminEmails();
    const email = (user.email ?? "").toLowerCase();
    if (allow.size === 0) {
      return jsonError("Dev credit grant is disabled (ADMIN_EMAILS is not set).", 403);
    }
    if (!email || !allow.has(email)) {
      return jsonError("Forbidden: dev credit grant is admin-only.", 403);
    }

    const body = (await request.json().catch(() => ({}))) as {
      amountCents?: number;
      targetUserId?: string;
    };
    const requested = Number.isFinite(body.amountCents) ? Math.floor(Number(body.amountCents)) : DEFAULT_GRANT_CENTS;
    if (requested <= 0) return jsonError("amountCents must be a positive integer.", 400);
    const amountCents = Math.min(requested, MAX_GRANT_CENTS);
    const targetUserId = body.targetUserId?.trim() || user.id;

    const account = await devGrantCredits(targetUserId, amountCents, `dev-grant:${user.id}`);
    return {
      ok: true,
      targetUserId,
      grantedCents: amountCents,
      balanceCents: account.availableBalanceCents,
      currency: CREDITS_CURRENCY
    };
  });
}
