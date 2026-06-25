import { forgeRemoveFavorite } from "@/lib/forge-favorites";

type RouteContext = { params: Promise<{ kitId: string }> };

export async function DELETE(request: Request, { params }: RouteContext) {
  const { kitId } = await params;
  return forgeRemoveFavorite(request, kitId);
}
