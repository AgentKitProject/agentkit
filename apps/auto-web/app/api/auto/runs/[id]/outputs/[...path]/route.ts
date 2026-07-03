// GET /api/auto/runs/[id]/outputs/[...path] — download one PERSISTED run
// output (BROWSER / cookie). Ownership-checked; the matching run.outputFiles
// manifest entry is presigned (OutputStore) and the client is 302-redirected —
// bytes are never proxied. Missing run/path, expired entry, or an
// OutputStore-less deployment → 404.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { presignRunOutput } from "@/server/core/auto-connections";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  const { id, path } = await params;
  const filePath = (path ?? []).join("/");
  const url = await presignRunOutput(userId, id, filePath);
  if (!url) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.redirect(url, 302);
}
