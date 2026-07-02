// POST /api/kits/:kitId/prepared-prompts/render -> renderPreparedPrompt
// body: { promptId, inputValues }
import { withUser } from "@/lib/api";
import { renderPreparedPrompt } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    const body = (await request.json()) as { promptId?: string; inputValues?: Record<string, unknown> };
    if (!body.promptId) throw new Error("promptId is required.");
    return renderPreparedPrompt(user.id, kitId, body.promptId, body.inputValues ?? {});
  });
}
