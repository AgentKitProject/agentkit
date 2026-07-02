// GET /api/kits/:kitId/prepared-prompts -> listPreparedPrompts
import { withUser } from "@/lib/api";
import { listPreparedPrompts } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    const prompts = await listPreparedPrompts(user.id, kitId);
    return { prompts };
  });
}
