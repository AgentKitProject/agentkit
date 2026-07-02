// POST /api/drafts/generate -> generateAgentKitDraftWithAi
// body: GenerateDraftInput. Provider config from the user's BYO settings, or
// (when none configured) MANAGED prepaid credits using the platform key.
import { withUser } from "@/lib/api";
import { generateDraft, type GenerateDraftInput } from "@/server/core/ai-draft";
import { insufficientCreditsResponse } from "@/server/core/credits-http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as GenerateDraftInput;
    if (!body.userRequest) throw new Error("userRequest is required.");
    try {
      return await generateDraft(user.id, body);
    } catch (error) {
      const credits = await insufficientCreditsResponse(error, user.id);
      if (credits) return credits;
      throw error;
    }
  });
}
