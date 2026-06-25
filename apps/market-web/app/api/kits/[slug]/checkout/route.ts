// Inert stub — real logic in the optional @agentkit-commercial/market-web pkg.
import { commercialHandlerOr503 } from "@/lib/commercial";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ slug: string }> };

const handle = commercialHandlerOr503("browserCheckoutKit");

export async function POST(request: Request, { params }: RouteContext) {
  const { slug } = await params;
  return handle(request, slug);
}
