// POST /api/import/zip -> importAgentKitPackage
// Multipart upload of a .agentkit.zip; creates a new kit from its tree.
import { withUser } from "@/lib/api";
import { importPackageZip } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUser(async (user) => {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Error("Multipart form field 'file' (.agentkit.zip) is required.");
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    return importPackageZip(user.id, bytes);
  });
}
