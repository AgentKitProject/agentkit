import { transferKit } from "@/lib/forge-orgs";

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const { slug } = await params;
  return transferKit(request, slug);
}
