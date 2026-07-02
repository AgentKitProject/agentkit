// POST /api/kits/:kitId/package -> packageAgentKit (returns .agentkit.zip bytes)
import { withUserRaw } from "@/lib/api";
import { packageKit } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUserRaw(async (user) => {
    const { bytes, fileName } = await packageKit(user.id, kitId);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${fileName}"`
      }
    });
  });
}
