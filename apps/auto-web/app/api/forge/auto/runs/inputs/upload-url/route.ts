// /api/forge/auto/runs/inputs/upload-url — presigned upload URLs for run input
// files (BEARER auth).
//
// Auth: WorkOS device-auth BEARER token (requireForgeUser) — NEVER the AuthKit
// cookie (CLAUDE.md hard rule #4). The cookie sibling lives at
// /api/auto/runs/inputs/upload-url. Same body + response as the cookie sibling.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import {
  AutoValidationError,
  InputStorageUnconfiguredError,
  createInputUploadUrls
} from "@/server/core/auto";

export const dynamic = "force-dynamic";

type UploadBody = { files?: unknown };

function parseFiles(body: UploadBody): { path: string; contentType?: string }[] {
  if (!Array.isArray(body.files)) return [];
  return (body.files as unknown[]).flatMap((f) => {
    if (!f || typeof f !== "object") return [];
    const rec = f as Record<string, unknown>;
    if (typeof rec["path"] !== "string") return [];
    return [
      {
        path: rec["path"],
        ...(typeof rec["contentType"] === "string" ? { contentType: rec["contentType"] } : {})
      }
    ];
  });
}

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

  const body = (await request.json().catch(() => ({}))) as UploadBody;
  try {
    const files = parseFiles(body);
    const result = await createInputUploadUrls({ userId, files });
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof InputStorageUnconfiguredError) {
      return Response.json({ error: autoErrorCodeSchema.enum.inputs_unconfigured, message: error.message }, { status: 503 });
    }
    if (error instanceof AutoValidationError) {
      return Response.json({ error: autoErrorCodeSchema.enum.invalid_request, message: error.message }, { status: 400 });
    }
    throw error;
  }
}
