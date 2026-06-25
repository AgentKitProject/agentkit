import { proxyUserLifecyclePost } from "@/lib/user-lifecycle-proxy";

type RouteContext = {
  params: Promise<{ submissionId?: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const { submissionId } = await params;

  if (!submissionId) {
    return Response.json({ code: "BAD_REQUEST", message: "Missing submissionId." }, { status: 400 });
  }

  return proxyUserLifecyclePost({
    route: `/api/submissions/${submissionId}/cancel`,
    backendPath: `/users/submissions/${encodeURIComponent(submissionId)}/cancel`
  });
}
