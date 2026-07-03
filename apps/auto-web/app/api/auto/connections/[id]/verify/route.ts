// POST /api/auto/connections/[id]/verify — server-side verify probe (BROWSER /
// cookie). Ownership-checked; missing / cross-user → 404.
//
//   s3             → ListObjectsV2 (max 1 key) with SecretStore-revealed creds.
//   webhook_out /
//   slack_incoming → https + SSRF-guard DNS resolve (nothing is posted).
//   email          → recipient format check.
//
// Stamps connection.status ok|error and returns the connection (plus
// `verifyError` detail on failure). Credentials are revealed SERVER-SIDE only.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { autoEventErrorResponse } from "@/server/core/auto-events";
import { connectionErrorResponse, verifyConnection } from "@/server/core/auto-connections";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  const { id } = await params;
  try {
    const result = await verifyConnection(userId, id);
    if (!result) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
    return Response.json(
      { ...result.connection, ...(result.error !== undefined ? { verifyError: result.error } : {}) },
      { status: 200 },
    );
  } catch (error) {
    const mapped = connectionErrorResponse(error) ?? autoEventErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  }
}
