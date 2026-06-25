import { proxyUserLifecyclePost } from "@/lib/user-lifecycle-proxy";

type RouteContext = {
  params: Promise<{ slug?: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const { slug: kitId } = await params;

  if (!kitId) {
    return Response.json({ code: "BAD_REQUEST", message: "Missing kitId." }, { status: 400 });
  }

  return proxyUserLifecyclePost({
    route: `/api/kits/${kitId}/remove`,
    backendPath: `/users/kits/${encodeURIComponent(kitId)}/remove`
  });
}
