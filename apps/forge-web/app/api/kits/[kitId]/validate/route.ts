// POST /api/kits/:kitId/validate -> validateAgentKit  body: { profile }
import { withUser } from "@/lib/api";
import { validateKit } from "@/server/core/operations";

export const dynamic = "force-dynamic";

type ValidationProfile = "local-valid" | "publishable" | "trusted" | "verified";

export async function POST(request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    const body = (await request.json().catch(() => ({}))) as { profile?: ValidationProfile };
    const profile = body.profile ?? "local-valid";
    const report = await validateKit(user.id, kitId, profile);
    return { report };
  });
}
