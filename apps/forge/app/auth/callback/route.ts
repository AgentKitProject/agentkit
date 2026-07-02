import { getAuthProvider } from "@/lib/auth-provider";
import type { NextRequest } from "next/server";

// Resolve URLs at request time, not build time. Keeps the image runtime-config.
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return getAuthProvider().handleCallback(request);
}
