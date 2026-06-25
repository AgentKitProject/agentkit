import { getAuthProvider } from "@/lib/auth-provider";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const provider = await getAuthProvider();
  return provider.handleSignOut(request);
}
