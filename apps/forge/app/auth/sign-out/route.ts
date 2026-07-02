import { getAuthProvider } from "@/lib/auth-provider";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return getAuthProvider().handleSignOut(request);
}
