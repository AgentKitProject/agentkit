// Inert stub — real logic in the optional @agentkit-commercial/market-web pkg.
import { commercialHandlerOr503 } from "@/lib/commercial";

type RouteContext = { params: Promise<{ slug: string }> };

const handle = commercialHandlerOr503("browserLicensedPackage");

export async function POST(request: Request, { params }: RouteContext) {
  const { slug } = await params;
  return handle(request, slug);
}
