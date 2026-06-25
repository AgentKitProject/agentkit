import { browserSetKitVisibility } from "@/lib/browser-orgs";

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const { slug } = await params;
  return browserSetKitVisibility(request, slug);
}
