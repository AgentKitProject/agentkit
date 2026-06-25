// POST /api/settings/ai-provider/test -> probe a configured provider's
// connectivity/credentials with a trivial prompt (no draft parsing).
import { withUser } from "@/lib/api";
import { testProvider } from "@/server/core/ai-draft";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json().catch(() => ({}))) as { providerId?: string; model?: string };
    return testProvider(user.id, { providerId: body.providerId, model: body.model });
  });
}
