/**
 * Browser favorites helpers — authenticate via the AuthKit cookie session
 * (WorkOS browser sessions), NOT the Forge device-auth bearer token. These
 * back the `/api/favorites` + `/api/favorites/[kitId]` routes used by the web
 * UI.
 *
 * Auth purity (CLAUDE.md hard rule #4): every helper here uses
 * `requireUserForApi` (AuthKit cookie) and nothing else — never the Forge
 * bearer path. The `/api/forge/favorites/*` routes are the bearer counterpart
 * and live in `lib/forge-favorites.ts`.
 *
 * A favorite is a cloud-synced REFERENCE to a Market kit, never a kit copy.
 * Both layers proxy the same Seam B backend route for the authed user via
 * `fetchAdminBackend` (admin key). Lists return `{ items: [...] }`.
 */

import { NextResponse } from "next/server";
import {
  marketBackendFavoritesRoutes,
  addFavoriteRequestSchema
} from "@agentkitforge/contracts";
import { fetchAdminBackend } from "@/lib/admin-api";
import { requireUserForApi, UnauthorizedError, ForbiddenError } from "@/lib/auth";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function favError(message: string, status: number): Response {
  return NextResponse.json({ message }, { status });
}

function handleException(error: unknown): Response {
  if (error instanceof UnauthorizedError) {
    return favError(error.message, 401);
  }
  if (error instanceof ForbiddenError) {
    return favError(error.message, 403);
  }
  const message = error instanceof Error ? error.message : "Request failed.";
  if (message.includes("Missing ") || message.includes("not configured")) {
    return favError("AgentKitMarket server configuration is incomplete.", 503);
  }
  return favError("AgentKitMarket could not complete the request.", 500);
}

async function proxyToBackend(backendPath: string, method: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const backendResponse = await fetchAdminBackend(backendPath, init);
  const text = await backendResponse.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    return favError("AgentKitMarket could not complete the request.", 500);
  }
  if (!backendResponse.ok) {
    const message =
      isRecord(payload) && typeof payload.message === "string"
        ? payload.message
        : "AgentKitMarket could not complete the request.";
    return favError(message, backendResponse.status);
  }
  return NextResponse.json(payload, { status: backendResponse.status });
}

// ---------------------------------------------------------------------------
// GET /api/favorites — list the signed-in user's favorites.
// ---------------------------------------------------------------------------

export async function browserListMyFavorites(): Promise<Response> {
  try {
    const user = await requireUserForApi();
    return proxyToBackend(marketBackendFavoritesRoutes.adminListUserFavorites(user.id), "GET");
  } catch (error) {
    return handleException(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/favorites — add a favorite by { slug | kitId }.
// ---------------------------------------------------------------------------

export async function browserAddFavorite(request: Request): Promise<Response> {
  try {
    const user = await requireUserForApi();
    const body = (await request.json().catch(() => ({}))) as unknown;
    const parsed = addFavoriteRequestSchema.safeParse(body);
    if (!parsed.success) {
      return favError(parsed.error.issues[0]?.message ?? "Either slug or kitId is required.", 400);
    }
    return proxyToBackend(marketBackendFavoritesRoutes.adminAddUserFavorite(user.id), "POST", parsed.data);
  } catch (error) {
    return handleException(error);
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/favorites/[kitId] — remove a favorite.
// ---------------------------------------------------------------------------

export async function browserRemoveFavorite(_request: Request, kitId: string): Promise<Response> {
  try {
    const user = await requireUserForApi();
    return proxyToBackend(marketBackendFavoritesRoutes.adminRemoveUserFavorite(user.id, kitId), "DELETE");
  } catch (error) {
    return handleException(error);
  }
}
