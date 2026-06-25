import { browserListMyFavorites, browserAddFavorite } from "@/lib/browser-favorites";

export async function GET() {
  return browserListMyFavorites();
}

export async function POST(request: Request) {
  return browserAddFavorite(request);
}
