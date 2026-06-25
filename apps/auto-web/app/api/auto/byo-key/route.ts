// /api/auto/byo-key — per-user BYO Anthropic key + inference-mode preference
// (BROWSER / cookie auth).
//
// Auth: AuthKit cookie session (requireUserForApi) — NEVER the forge bearer
// (CLAUDE.md hard rule #4). A user supplies their OWN Anthropic key so their Auto
// runs use it (inferenceMode "byo", no managed-credit debit). They can also pick,
// per account, whether to prefer byo or managed.
//
//   GET    → secret-free status { hasKey, inferenceMode }.
//   PUT    → set/update the key and/or the inference-mode preference.
//   DELETE → clear the key (revert to managed credits).
//
// SECURITY: the key is a SECRET. It is encrypted at rest by the UserSettingsStore
// (AES-256-GCM via AGENTKITFORGE_WEB_SECRET) and is NEVER returned by any of these
// responses, NEVER logged, and validated for shape only (no network call here).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import {
  ByoKeyValidationError,
  clearByoKey,
  getByoKeyStatus,
  setByoKey,
  type InferenceModePreference
} from "@/server/core/auto-byo";

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

function parseInferenceMode(raw: unknown): InferenceModePreference | undefined {
  return raw === "auto" || raw === "managed" || raw === "byo" ? raw : undefined;
}

export async function GET() {
  const auth = await userIdOr401();
  if ("response" in auth) return auth.response;
  const status = await getByoKeyStatus(auth.userId);
  return Response.json(status, { status: 200 });
}

export async function PUT(request: Request) {
  const auth = await userIdOr401();
  if ("response" in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as {
    apiKey?: unknown;
    inferenceMode?: unknown;
  };

  const apiKey = typeof body.apiKey === "string" ? body.apiKey : undefined;
  const inferenceMode = parseInferenceMode(body.inferenceMode);

  // Reject an explicit non-string apiKey, or an invalid inferenceMode value.
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
    return Response.json(
      { error: autoErrorCodeSchema.enum.invalid_request, message: "apiKey must be a string." },
      { status: 400 }
    );
  }
  if (body.inferenceMode !== undefined && inferenceMode === undefined) {
    return Response.json(
      { error: autoErrorCodeSchema.enum.invalid_request, message: 'inferenceMode must be "auto", "managed", or "byo".' },
      { status: 400 }
    );
  }
  if (apiKey === undefined && inferenceMode === undefined) {
    return Response.json(
      { error: autoErrorCodeSchema.enum.invalid_request, message: "Nothing to update." },
      { status: 400 }
    );
  }

  try {
    const status = await setByoKey(auth.userId, {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(inferenceMode !== undefined ? { inferenceMode } : {})
    });
    return Response.json(status, { status: 200 });
  } catch (error) {
    if (error instanceof ByoKeyValidationError) {
      // The message NEVER contains the key (validateAnthropicKeyFormat guarantees it).
      return Response.json(
        { error: autoErrorCodeSchema.enum.invalid_request, message: error.message },
        { status: 400 }
      );
    }
    throw error;
  }
}

export async function DELETE() {
  const auth = await userIdOr401();
  if ("response" in auth) return auth.response;
  const status = await clearByoKey(auth.userId);
  return Response.json(status, { status: 200 });
}
