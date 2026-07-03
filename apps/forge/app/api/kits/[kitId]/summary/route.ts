// GET /api/kits/:kitId/summary -> getAgentKitSummary
//   + the kit's suggested `automations:` entries (additive; [] when absent)
//     for the editor's Automations card ("Enable in Auto" deep links).
import { withUser } from "@/lib/api";
import { getKitAutomations, getKitSummary } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    const [summary, automations] = await Promise.all([
      getKitSummary(user.id, kitId),
      getKitAutomations(user.id, kitId)
    ]);
    return { summary, automations };
  });
}
