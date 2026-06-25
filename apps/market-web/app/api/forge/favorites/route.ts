import { forgeListMyFavorites, forgeAddFavorite } from "@/lib/forge-favorites";

export async function GET(request: Request) {
  return forgeListMyFavorites(request);
}

export async function POST(request: Request) {
  return forgeAddFavorite(request);
}
