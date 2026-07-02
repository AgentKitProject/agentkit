// POST /api/kits/:kitId/export/codex -> exportAgentKitToCodex (zip of folder)
import { withUserRaw } from "@/lib/api";
import { exportToCodex } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUserRaw(async (user) => {
    const { bytes, fileName } = await exportToCodex(user.id, kitId);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${fileName}"`
      }
    });
  });
}
