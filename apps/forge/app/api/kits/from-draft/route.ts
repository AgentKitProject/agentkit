// POST /api/kits/from-draft -> renderGeneratedAgentKitDraft (into a new kit)
// body: { draftJson }
import { withUser } from "@/lib/api";
import { createKitFromDraft } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as { draftJson?: unknown };
    if (body.draftJson === undefined) {
      throw new Error("draftJson is required.");
    }
    const kit = await createKitFromDraft(user.id, body.draftJson);
    return { kit };
  });
}
