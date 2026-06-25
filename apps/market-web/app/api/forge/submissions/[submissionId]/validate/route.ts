import { validateForgeSubmission } from "@/lib/forge-submissions";

type RouteContext = {
  params: Promise<{ submissionId?: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { submissionId } = await params;
  return validateForgeSubmission(request, submissionId);
}
