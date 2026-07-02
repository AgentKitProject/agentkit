// POST /api/import/git -> importAgentKitFromGit  body: { repositoryUrl, reference }
import { withUser } from "@/lib/api";
import { importFromGit } from "@/server/core/import-ops";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as { repositoryUrl?: string; reference?: string };
    if (!body.repositoryUrl) throw new Error("repositoryUrl is required.");
    return importFromGit(user.id, body.repositoryUrl, body.reference ?? "");
  });
}
