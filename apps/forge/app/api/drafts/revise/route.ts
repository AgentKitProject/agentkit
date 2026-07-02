// POST /api/drafts/revise -> reviseAgentKitDraftWithAi
// body: ReviseDraftInput. Provider config from the user's BYO settings, or
// (when none configured) MANAGED prepaid credits using the platform key.
import { withUser } from "@/lib/api";
import { reviseDraft, type ReviseDraftInput } from "@/server/core/ai-draft";
import { insufficientCreditsResponse } from "@/server/core/credits-http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as ReviseDraftInput;
    if (!body.session || !body.changeRequest) throw new Error("session and changeRequest are required.");
    try {
      return await reviseDraft(user.id, body);
    } catch (error) {
      const credits = await insufficientCreditsResponse(error, user.id);
      if (credits) return credits;
      throw error;
    }
  });
}
