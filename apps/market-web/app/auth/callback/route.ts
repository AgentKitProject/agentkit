import { getAuthProvider } from "@/lib/auth-provider";
import type { NextRequest } from "next/server";

// Resolve URLs/handlers at request time, not build time. Keeps the image
// runtime-configured (one image, env supplied at deploy).
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const provider = await getAuthProvider();
  return provider.handleCallback(request);
}
