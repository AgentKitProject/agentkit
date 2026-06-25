import { NextResponse } from "next/server";
import { getPublicProfileByHandle, ProfileApiError } from "@/lib/profile/service";
import { isValidHandle, normalizeHandle } from "@/lib/profile/validation";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  const { handle } = await params;
  const normalizedHandle = normalizeHandle(handle);

  if (!isValidHandle(normalizedHandle)) {
    return NextResponse.json({ error: "Invalid handle." }, { status: 400 });
  }

  try {
    const profile = await getPublicProfileByHandle(normalizedHandle);

    if (!profile) {
      return NextResponse.json({ error: "Profile not found." }, { status: 404 });
    }

    return NextResponse.json(profile, {
      headers: {
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (error) {
    if (error instanceof ProfileApiError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }

    return NextResponse.json({ error: "Profile service unavailable." }, { status: 500 });
  }
}
