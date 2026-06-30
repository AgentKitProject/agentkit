import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserRole } from "@/lib/auth/roles";

export async function GET() {
  const user = await getCurrentUser();

  return NextResponse.json(
    user
      ? {
          authenticated: true,
          role: getUserRole(user),
          email: user.email,
        }
      : { authenticated: false },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
