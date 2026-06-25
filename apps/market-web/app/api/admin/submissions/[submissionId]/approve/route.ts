import { proxyAdminPost } from "@/lib/admin-proxy";

type RouteContext = {
  params: Promise<{ submissionId?: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { submissionId } = await params;

  if (!submissionId) {
    return Response.json({ code: "BAD_REQUEST", message: "Missing submissionId." }, { status: 400 });
  }

  const body = await safeJson(request);

  return proxyAdminPost({
    route: `/api/admin/submissions/${submissionId}/approve`,
    backendPath: `/admin/submissions/${encodeURIComponent(submissionId)}/approve`,
    body
  });
}

async function safeJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
