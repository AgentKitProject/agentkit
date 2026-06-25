/**
 * Forge favorites helpers — the Forge device-auth (BEARER) counterparts of
 * `lib/browser-favorites.ts`. They back the `/api/forge/favorites` +
 * `/api/forge/favorites/[kitId]` routes used by the AgentKitForge desktop app
 * and CLI, and the web Forge.
 *
 * Auth purity (CLAUDE.md hard rule #4): every helper here uses
 * `requireForgeUser` (device-auth bearer) and nothing else — NEVER the AuthKit
 * cookie session. They proxy to the admin-key authenticated Seam B backend
 * (`fetchAdminBackend`), deriving userId from the verified Forge user id.
 *
 * A favorite is a cloud-synced REFERENCE to a Market kit, never a kit copy.
 * Lists return `{ items: [...] }`.
 */

import { NextResponse } from "next/server";
import {
  marketBackendFavoritesRoutes,
  addFavoriteRequestSchema
} from "@agentkitforge/contracts";
import { fetchAdminBackend, AdminConfigError } from "@/lib/admin-api";
import { ForgeAuthError, requireForgeUser } from "@/lib/forge-auth";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(code: string, message: string, status: number): Response {
  return NextResponse.json({ code, error: code, message }, { status });
}

function handleException(error: unknown): Response {
  if (error instanceof ForgeAuthError) {
    if (error.code === "SERVER_CONFIG_ERROR") {
      return jsonError("SERVER_CONFIG_ERROR", error.message, 500);
    }
    if (error.code === "NOT_SUPPORTED") {
      return jsonError("FORGE_AUTH_NOT_SUPPORTED", error.message, 501);
    }
    return jsonError("NOT_SIGNED_IN", "AgentKitProject sign-in is required.", 401);
  }
  if (error instanceof AdminConfigError) {
    return jsonError("SERVER_CONFIG_ERROR", error.message, 500);
  }
  return jsonError("BACKEND_UNAVAILABLE", "AgentKitMarket could not complete the request.", 502);
}

async function readBackendJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}

function backendMessage(payload: unknown, fallback: string): string {
  return isRecord(payload) && typeof payload.message === "string" ? payload.message : fallback;
}

// ---------------------------------------------------------------------------
// GET /api/forge/favorites — list the signed-in Forge user's favorites.
// ---------------------------------------------------------------------------

export async function forgeListMyFavorites(request: Request): Promise<Response> {
  try {
    const user = await requireForgeUser(request);
    const response = await fetchAdminBackend(
      marketBackendFavoritesRoutes.adminListUserFavorites(user.id),
      { method: "GET" }
    );
    const payload = await readBackendJson(response);
    if (!response.ok) {
      return jsonError("BACKEND_UNAVAILABLE", backendMessage(payload, "Could not load favorites."), response.status);
    }
    const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
    return NextResponse.json({ items }, { status: 200 });
  } catch (error) {
    return handleException(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/forge/favorites — add a favorite by { slug | kitId }.
// ---------------------------------------------------------------------------

export async function forgeAddFavorite(request: Request): Promise<Response> {
  try {
    const user = await requireForgeUser(request);
    const body = (await request.json().catch(() => ({}))) as unknown;
    const parsed = addFavoriteRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Either slug or kitId is required.", 400);
    }
    const response = await fetchAdminBackend(
      marketBackendFavoritesRoutes.adminAddUserFavorite(user.id),
      { method: "POST", body: JSON.stringify(parsed.data) }
    );
    const payload = await readBackendJson(response);
    if (!response.ok) {
      return jsonError("BACKEND_UNAVAILABLE", backendMessage(payload, "Could not add favorite."), response.status);
    }
    return NextResponse.json(isRecord(payload) ? payload : {}, { status: response.status });
  } catch (error) {
    return handleException(error);
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/forge/favorites/[kitId] — remove a favorite.
// ---------------------------------------------------------------------------

export async function forgeRemoveFavorite(request: Request, kitId: string): Promise<Response> {
  try {
    const user = await requireForgeUser(request);
    const response = await fetchAdminBackend(
      marketBackendFavoritesRoutes.adminRemoveUserFavorite(user.id, kitId),
      { method: "DELETE" }
    );
    const payload = await readBackendJson(response);
    if (!response.ok) {
      return jsonError("BACKEND_UNAVAILABLE", backendMessage(payload, "Could not remove favorite."), response.status);
    }
    return NextResponse.json(isRecord(payload) ? payload : { ok: true, kitId }, { status: response.status });
  } catch (error) {
    return handleException(error);
  }
}
