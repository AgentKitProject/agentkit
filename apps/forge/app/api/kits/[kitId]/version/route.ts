// POST /api/kits/:kitId/version — bump kit version
// body: { version: string } — the new version string (e.g. "2", "3")
// Uses setAgentKitVersion from @agentkitforge/core, then persists the tree.
import { withUser } from "@/lib/api";
import { withMaterializedKit } from "@/server/core/runner";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    const body = (await request.json()) as { version?: string };
    if (!body.version) throw new Error("version is required.");
    const version = String(body.version).trim();
    return withMaterializedKit(user.id, kitId, async ({ core, kitRoot }) => {
      await core.setAgentKitVersion(kitRoot, version);
      const next = await core.nextAgentKitVersion(kitRoot);
      return { ok: true, version, next };
    }, { persist: true });
  });
}
