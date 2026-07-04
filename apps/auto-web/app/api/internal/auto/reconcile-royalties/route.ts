// /api/internal/auto/reconcile-royalties — M6 #5 durable royalty-accrual reconciliation.
//
// THIRD auth path: SERVICE KEY ONLY. This is an operational / cron endpoint (like
// /api/internal/auto/sweep) invoked by a headless k8s CronJob — NOT a browser, NOT
// Forge. It uses the SAME AUTO_WORKER_SERVICE_KEY gate as sweep + resolve-context
// (constant-time compare; x-service-key OR Authorization: Bearer; 503 when the key
// is unset). It must NEVER use the AuthKit cookie helpers or the Forge bearer
// helper — those are the other two, separate auth paths (CLAUDE.md hard rule #4).
//
// It re-drives every pending unaccrued royalty (a buyer-charged premium royalty
// whose seller accrual threw) through the idempotent gateway accrual and returns
// the structured ReconcileRoyalties result. INERT on open-core / self-host: on a
// non-Postgres backend or with no gateway configured it returns a clean empty
// result (nothing pending). The service-key gate + reconciliation logic live in
// the wrapper (server/core/royalty-reconciliation.ts).
import { serviceRunRoyaltyReconciliation } from "@/server/core/royalty-reconciliation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return serviceRunRoyaltyReconciliation(request);
}
