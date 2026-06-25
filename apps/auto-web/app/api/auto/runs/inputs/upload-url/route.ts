// /api/auto/runs/inputs/upload-url — presigned upload URLs for run input files
// (BROWSER / cookie auth).
//
// Auth: AuthKit cookie session (requireUserForApi). The bearer sibling lives at
// /api/forge/auto/runs/inputs/upload-url (CLAUDE.md hard rule #4).
//
// POST { files: [{ path, contentType? }, ...] } → presigned S3 PUT URL(s) under
// the per-user input prefix (auto-inputs/{userId}/{stagingId}/...). The client
// PUTs each file's bytes, then includes the returned `inputFiles` manifest in the
// run-create body (POST /api/auto/runs). The worker hydrates them into the run
// workspace inputs/ dir via auto-core's S3InputStore. Filenames are path-safe
// (auto-core's confineInputPath rejects absolute paths + traversal).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
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
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
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
