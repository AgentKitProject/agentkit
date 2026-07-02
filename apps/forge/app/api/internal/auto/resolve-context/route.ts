// /api/internal/auto/resolve-context — INTERNAL worker context resolution.
//
// THIRD auth path: SERVICE KEY ONLY. This endpoint is consumed by the hosted
// Fargate Auto worker (NOT a browser, NOT Forge). It must NEVER use the AuthKit
// cookie helpers or the Forge bearer helper (requireForgeUser) — those are the
// other two, separate auth paths (CLAUDE.md hard rule #4). The service key is the
// sole authorization here: the worker presents the key it was provisioned with,
// and in return receives the run's resolved system prompt + tools + billing/BYO
// config so it can execute the run on hosted compute.
//
// The worker hits WEB_FORGE_INTERNAL_URL + this path. The service key lives in
// AUTO_WORKER_SERVICE_KEY (server-only; never shipped to a browser bundle or to
// Forge). When the key is unset the endpoint is DISABLED (503) — it never falls
// back to unauthenticated access.
//
// SECURITY: the systemPrompt/kitContext and the byoProvider.apiKey are returned
// ONLY to the service-key caller. They are NEVER logged here and NEVER returned to
// the browser. We log only the runId, inferenceMode, and tool count.
import { autoErrorCodeSchema, autoInternalServiceKeyHeader } from "@agentkitforge/contracts";
import { timingSafeEqual } from "node:crypto";
import { resolveWorkerContext } from "@/server/core/auto";

export const dynamic = "force-dynamic";

/** Constant-time compare. timingSafeEqual throws on differing lengths, so we
 *  reject a length mismatch first (the length itself is not the secret). */
function serviceKeyMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the presented service key from x-service-key OR Authorization: Bearer.
 *  The worker sends both; either is accepted. */
function presentedKey(request: Request): string | null {
  const headerKey = request.headers.get(autoInternalServiceKeyHeader);
  if (headerKey && headerKey.length > 0) return headerKey;
  const auth = request.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

export async function POST(request: Request) {
  // ---- Service-key gate (THIRD auth path; service key only) ----------------
  const expected = process.env.AUTO_WORKER_SERVICE_KEY;
  if (!expected || expected.length === 0) {
    // Disabled until a key is configured — never allow unauthenticated access.
    return Response.json({ error: autoErrorCodeSchema.enum.internal_auth_unconfigured }, { status: 503 });
  }
  const presented = presentedKey(request);
  if (!presented || !serviceKeyMatches(expected, presented)) {
    return Response.json({ error: autoErrorCodeSchema.enum.unauthorized }, { status: 401 });
  }

  // ---- Body validation -----------------------------------------------------
  const body = (await request.json().catch(() => ({}))) as { runId?: unknown };
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  if (runId.length === 0) {
    return Response.json({ error: autoErrorCodeSchema.enum.invalid_request, message: "runId is required." }, { status: 400 });
  }

  // ---- Resolve server-side -------------------------------------------------
  // resolveWorkerContext loads run + approval (NO ownership check — the service
  // key IS the authorization) and resolves the kit context + billing/BYO config.
  let ctx;
  try {
    ctx = await resolveWorkerContext(runId);
  } catch {
    // Missing run / no approval → 404 (do not leak details).
    return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  }

  // Log ONLY non-sensitive facts (never the prompt or BYO key).
  // eslint-disable-next-line no-console
  console.info(
    `[auto] resolve-context run=${runId} mode=${ctx.inferenceMode} tools=${ctx.toolNames.length}`
  );

  // Return the full context to the service-key caller (the worker). NEVER expose
  // this payload to the browser.
  return Response.json(ctx, { status: 200 });
}
