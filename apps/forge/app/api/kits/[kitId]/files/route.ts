// PUT    /api/kits/:kitId/files -> writeKitFile  body: { path, content, encoding? }
// DELETE /api/kits/:kitId/files -> deleteKitFile body: { path }
import { withUser } from "@/lib/api";
import { getKitStore } from "@/server/store/local-disk";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    const body = (await request.json()) as { path?: string; content?: string; encoding?: "utf8" | "base64" };
    if (!body.path || body.content === undefined) {
      throw new Error("path and content are required.");
    }
    await (await getKitStore()).writeKitFile(user.id, kitId, {
      path: body.path,
      content: body.content,
      encoding: body.encoding ?? "utf8"
    });
    return { ok: true };
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    const body = (await request.json()) as { path?: string };
    if (!body.path) throw new Error("path is required.");
    await (await getKitStore()).deleteKitFile(user.id, kitId, body.path);
    return { ok: true };
  });
}
