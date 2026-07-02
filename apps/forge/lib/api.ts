// Shared API-route plumbing: enforce an authenticated user and map errors to
// JSON responses. Every /api/* route uses withUser().
import { NextResponse } from "next/server";
import { requireUserForApi, UnauthorizedError, type CurrentUser } from "@/lib/auth";
import { KitValidationError } from "@/server/core/operations";
import { QuotaExceededError } from "@/server/store/quota";

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function withUser<T>(handler: (user: CurrentUser) => Promise<T>): Promise<NextResponse> {
  let user: CurrentUser;
  try {
    user = await requireUserForApi();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return jsonError(error.message, 401);
    }
    throw error;
  }

  try {
    const result = await handler(user);
    if (result instanceof NextResponse) {
      return result;
    }
    return NextResponse.json(result ?? { ok: true });
  } catch (error) {
    if (error instanceof KitValidationError) {
      return jsonError(error.message, 422);
    }
    if (error instanceof QuotaExceededError) {
      // 413 for byte overages, 409 for kit-count overages.
      const status = error.kind === "kit-count" ? 409 : 413;
      return jsonError(error.message, status);
    }
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 400);
  }
}

/** Variant for routes that stream/return raw bytes (Response, not JSON). */
export async function withUserRaw(handler: (user: CurrentUser) => Promise<Response>): Promise<Response> {
  let user: CurrentUser;
  try {
    user = await requireUserForApi();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return jsonError(error.message, 401);
    }
    throw error;
  }
  try {
    return await handler(user);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 400);
  }
}
