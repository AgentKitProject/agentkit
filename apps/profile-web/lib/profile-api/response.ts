import "server-only";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/profile-api/validation";
import type { HandlerResult } from "@/lib/profile-api/handlers";

/** Renders a handler result, mapping thrown ApiErrors to their status + message. */
export function renderResult(result: HandlerResult): NextResponse {
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function renderError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ message: error.message }, { status: error.statusCode });
  }

  console.error("Unhandled profile API error", error);
  return NextResponse.json({ message: "Internal server error" }, { status: 500 });
}

/** Parses a JSON request body, defaulting to `{}` for empty bodies (Lambda parity). */
export async function parseJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "Request body must be valid JSON");
  }
}
