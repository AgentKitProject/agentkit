import { browserRemoveFavorite } from "@/lib/browser-favorites";

type RouteContext = { params: Promise<{ kitId: string }> };

export async function DELETE(request: Request, { params }: RouteContext) {
  const { kitId } = await params;
  return browserRemoveFavorite(request, kitId);
}
