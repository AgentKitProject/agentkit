import { proxyAdminPost } from "@/lib/admin-proxy";

type RouteContext = {
  params: Promise<{ kitId?: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const { kitId } = await params;

  if (!kitId) {
    return Response.json({ code: "BAD_REQUEST", message: "Missing kitId." }, { status: 400 });
  }

  return proxyAdminPost({
    route: `/api/admin/kits/${kitId}/unhide`,
    backendPath: `/admin/kits/${encodeURIComponent(kitId)}/unhide`
  });
}
