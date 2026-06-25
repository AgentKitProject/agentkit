import { proxyAdminPost } from "@/lib/admin-proxy";

type RouteContext = {
  params: Promise<{ submissionId?: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const { submissionId } = await params;

  if (!submissionId) {
    return Response.json({ code: "BAD_REQUEST", message: "Missing submissionId." }, { status: 400 });
  }

  return proxyAdminPost({
    route: `/api/admin/submissions/${submissionId}/remove`,
    backendPath: `/admin/submissions/${encodeURIComponent(submissionId)}/remove`
  });
}
