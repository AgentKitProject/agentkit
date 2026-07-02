// /api/hooks/auto/events/[sourceId]/[eventName] — PUBLIC event ingest (Seam C).
//
// Auth is the per-source bearer token (custom sources) or the provider's
// inbound signature (github/stripe/slack/sns) — NEVER a cookie, bearer JWT, or
// service key. The whole pipeline (auth matrix, L2 rate limit, payload cap,
// ring-buffer append, trigger fan-out) lives in server/core/event-ingest.ts;
// this route is a thin wrapper. Matches contracts autoEventIngestRoutes.emit.
import { handleEventIngest } from "@/server/core/event-ingest";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sourceId: string; eventName: string }> },
) {
  const { sourceId, eventName } = await params;
  return handleEventIngest(request, sourceId, eventName);
}
