// /api/forge/auto/runs — AgentKitAuto runs (BEARER auth).
//
// Auth: WorkOS device-auth BEARER token (requireForgeUser) — NEVER the AuthKit
// cookie (CLAUDE.md hard rule #4). The cookie sibling lives at /api/auto/runs.
//
//   POST → start a run { kitRef, input, budgetCents (REQUIRED), model? }. The
//          verified bearer is forwarded into kit-context resolution so a protected
//          Market kit is fetched + entitlement-checked server-side. Enforces the
//          approval gate (403 on denial), creates + DISPATCHES the run.
//   GET  → list the user's runs.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError, parseBearerToken } from "@/lib/forge-auth";
import {
  ApprovalDeniedError,
  AutoValidationError,
  InsufficientComputeBalanceError,
  MonthlyLimitExceededError,
  listRuns,
  parseDeliveryConfig,
  parseInputFiles,
  parseKitRef,
  startRun
} from "@/server/core/auto";
import { resolveRunBudgetCents } from "@/server/core/run-budget";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let userId: string;
  try {
    userId = (await requireForgeUser(request)).id;
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
  const bearerToken = parseBearerToken(request.headers.get("authorization")) ?? undefined;

  const body = (await request.json().catch(() => ({}))) as {
    kitRef?: unknown;
    input?: { prompt?: unknown; files?: unknown };
    prompt?: unknown;
    budgetCents?: unknown;
    model?: unknown;
    inputFiles?: unknown;
    deliveryConfig?: unknown;
  };

  try {
    const kitRef = parseKitRef(body.kitRef);
    const prompt =
      typeof body.input?.prompt === "string"
        ? body.input.prompt
        : typeof body.prompt === "string"
          ? body.prompt
          : "";
    const files = Array.isArray(body.input?.files)
      ? (body.input.files as unknown[]).flatMap((f) =>
          f && typeof f === "object" && typeof (f as Record<string, unknown>).path === "string"
            ? [{ path: String((f as Record<string, unknown>).path), content: String((f as Record<string, unknown>).content ?? "") }]
            : []
        )
      : undefined;
    // Budget: bearer/CLI clients may still send an explicit budgetCents; when
    // omitted, resolve it server-side (org override → user default → 50¢).
    const budgetCents =
      typeof body.budgetCents === "number" ? body.budgetCents : await resolveRunBudgetCents(userId);
    const model = typeof body.model === "string" ? body.model : undefined;
    const inputFiles = parseInputFiles(body.inputFiles);
    // Phase D: opt-in result delivery (email + signed webhook). Validated here
    // (https-only webhook, basic email format) → AutoValidationError → 400.
    const deliveryConfig = parseDeliveryConfig(body.deliveryConfig);

    const run = await startRun({
      userId,
      kitRef,
      prompt,
      budgetCents,
      ...(model ? { model } : {}),
      ...(files ? { files } : {}),
      ...(inputFiles.length > 0 ? { inputFiles } : {}),
      ...(deliveryConfig ? { deliveryConfig } : {}),
      // Forge path: forward the already-verified bearer so protected/Market kit
      // context is fetched + entitlement-checked server-side at run time.
      kitContext: bearerToken ? { bearerToken } : {}
    });
    return Response.json({ id: run.id, status: run.status, createdAt: run.createdAt }, { status: 201 });
  } catch (error) {
    if (error instanceof ApprovalDeniedError) {
      return Response.json({ error: autoErrorCodeSchema.enum.approval_denied, message: error.message }, { status: 403 });
    }
    if (error instanceof MonthlyLimitExceededError) {
      return Response.json({ error: autoErrorCodeSchema.enum.org_limit_exceeded, message: error.message }, { status: 403 });
    }
    if (error instanceof AutoValidationError) {
      return Response.json({ error: autoErrorCodeSchema.enum.invalid_request, message: error.message }, { status: 400 });
    }
    if (error instanceof InsufficientComputeBalanceError) {
      return Response.json(
        { error: autoErrorCodeSchema.enum.insufficient_balance, message: error.message, requiredCents: error.requiredCents },
        { status: 402 }
      );
    }
    throw error;
  }
}

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = (await requireForgeUser(request)).id;
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
  // Degrade gracefully on a read failure (uninitialized/unreachable store)
  // rather than 500-ing the caller; an empty list is a valid empty state.
  try {
    const runs = await listRuns(userId);
    return Response.json({ runs }, { status: 200 });
  } catch (error) {
    console.error("[auto] listRuns failed", error);
    return Response.json({ runs: [] }, { status: 200 });
  }
}
