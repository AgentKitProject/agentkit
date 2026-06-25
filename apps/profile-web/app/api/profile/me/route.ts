import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserRole } from "@/lib/auth/roles";
import { getProfileForUser, ProfileApiError, updateProfileForUser } from "@/lib/profile/service";
import { normalizeEditableProfileInput, validateEditableProfileInput } from "@/lib/profile/validation";

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!user.id) {
    console.error("[profile-api] session user missing", {
      userIdPresent: false,
      emailPresent: Boolean(user.email),
    });
    return NextResponse.json({ error: "SESSION_USER_MISSING" }, { status: 401 });
  }

  try {
    return NextResponse.json(await getProfileForUser(user, getUserRole(user)), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return profileErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!user.id) {
    console.error("[profile-api] session user missing", {
      userIdPresent: false,
      emailPresent: Boolean(user.email),
    });
    return NextResponse.json({ error: "SESSION_USER_MISSING" }, { status: 401 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const input = normalizeEditableProfileInput(body as Record<string, string>);
  const errors = validateEditableProfileInput(input);

  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  try {
    return NextResponse.json(await updateProfileForUser(user, getUserRole(user), input), {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return profileErrorResponse(error);
  }
}

function profileErrorResponse(error: unknown) {
  if (error instanceof ProfileApiError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  }

  return NextResponse.json({ error: "Profile service unavailable." }, { status: 500 });
}
