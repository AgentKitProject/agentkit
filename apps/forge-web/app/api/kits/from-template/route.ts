// POST /api/kits/from-template -> createAgentKitFromTemplate
// body: { template, id, name, description }
import { withUser } from "@/lib/api";
import { getKitStore } from "@/server/store/local-disk";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as {
      template?: string;
      id?: string;
      name?: string;
      description?: string;
    };
    if (!body.template || !body.id || !body.name || !body.description) {
      throw new Error("template, id, name and description are required.");
    }
    const meta = await (await getKitStore()).createKit(user.id, {
      kind: "template",
      template: body.template,
      id: body.id,
      name: body.name,
      description: body.description
    });
    return { kit: meta };
  });
}
