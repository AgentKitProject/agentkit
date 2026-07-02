// POST /api/kits/:kitId/export/claude-code -> exportAgentKitToClaudeCode (zip)
import { withUserRaw } from "@/lib/api";
import { exportToClaudeCode } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUserRaw(async (user) => {
    const { bytes, fileName } = await exportToClaudeCode(user.id, kitId);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${fileName}"`
      }
    });
  });
}
