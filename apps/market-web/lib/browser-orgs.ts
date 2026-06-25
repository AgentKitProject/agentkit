/**
 * Browser org helpers — authenticate via AuthKit cookie session (WorkOS browser
 * sessions) instead of the Forge device-auth bearer token.  These back the
 * `/api/orgs/*` and `/api/kits/[slug]/{transfer,visibility}` routes used by
 * the web UI.  The `/api/forge/*` org routes remain unchanged for CLI consumers.
 */

import { NextResponse } from "next/server";
import {
  marketBackendOrgRoutes,
  createOrgRequestSchema,
  addOrgMemberRequestSchema,
  acceptOrgInviteRequestSchema,
  transferKitRequestSchema,
  setKitVisibilityRequestSchema
} from "@agentkitforge/contracts";
import { fetchAdminBackend } from "@/lib/admin-api";
import { requireUserForApi, UnauthorizedError, ForbiddenError } from "@/lib/auth";
import { resolveWorkOsUserIdByEmail, ForgeAccountError } from "@/lib/forge-account";

// ---------------------------------------------------------------------------
// Generic proxy helpers
// ---------------------------------------------------------------------------

async function proxyToBackend(
  backendPath: string,
  method: string,
  body?: unknown
): Promise<Response> {
  const init: RequestInit = { method };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const backendResponse = await fetchAdminBackend(backendPath, init);

  if (backendResponse.status === 204) {
    return NextResponse.json({}, { status: 204 });
  }

  const text = await backendResponse.text();
  let payload: unknown;

  try {
    payload = JSON.parse(text);
  } catch {
    console.error("[agentkitmarket] browser-orgs backend non-json", {
      backendPath,
      status: backendResponse.status,
      snippet: text.slice(0, 200)
    });
    return browserOrgError("AgentKitMarket could not complete the request.", 500);
  }

  if (!backendResponse.ok) {
    const message =
      isRecord(payload) && typeof payload.message === "string"
        ? payload.message
        : "AgentKitMarket could not complete the request.";
    return browserOrgError(message, backendResponse.status);
  }

  return NextResponse.json(payload, { status: backendResponse.status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function browserOrgError(message: string, status: number): Response {
  return NextResponse.json({ message }, { status });
}

function handleBrowserOrgException(error: unknown): Response {
  if (error instanceof UnauthorizedError) {
    return browserOrgError(error.message, 401);
  }
  if (error instanceof ForbiddenError) {
    return browserOrgError(error.message, 403);
  }
  const message = error instanceof Error ? error.message : "Request failed.";
  if (message.includes("Missing ") || message.includes("not configured")) {
    return browserOrgError("AgentKitMarket server configuration is incomplete.", 503);
  }
  return browserOrgError("AgentKitMarket could not complete the request.", 500);
}

// ---------------------------------------------------------------------------
// Orgs — list / create
// ---------------------------------------------------------------------------

export async function browserListMyOrgs() {
  try {
    const user = await requireUserForApi();
    return proxyToBackend(marketBackendOrgRoutes.adminListUserOrgs(user.id), "GET");
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

export async function browserCreateOrg(request: Request) {
  try {
    const user = await requireUserForApi();
    const body = (await request.json()) as unknown;
    const parsed = createOrgRequestSchema.safeParse(body);

    if (!parsed.success) {
      return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    const backendBody = { ...parsed.data, ownerUserId: user.id };
    return proxyToBackend(marketBackendOrgRoutes.adminCreateOrg(), "POST", backendBody);
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Org members — list / add
// ---------------------------------------------------------------------------

export async function browserListOrgMembers(_request: Request, orgId: string) {
  try {
    await requireUserForApi();
    return proxyToBackend(marketBackendOrgRoutes.adminOrgMembers(orgId), "GET");
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

export async function browserAddOrgMember(request: Request, orgId: string) {
  try {
    const user = await requireUserForApi();
    const body = (await request.json()) as unknown;

    // Accept { email, role } from the UI — resolve email → userId server-side.
    if (isRecord(body) && typeof body.email === "string") {
      const email = body.email.trim().toLowerCase();

      if (!email) {
        return browserOrgError("Email is required.", 400);
      }

      let resolvedUserId: string | undefined;

      try {
        resolvedUserId = await resolveWorkOsUserIdByEmail(email);
      } catch (err) {
        if (err instanceof ForgeAccountError && err.code === "ACCOUNT_CONFIG_ERROR") {
          return browserOrgError("AgentKitMarket server configuration is incomplete.", 503);
        }
        return browserOrgError("AgentKitMarket could not look up that email.", 502);
      }

      if (!resolvedUserId) {
        return browserOrgError("No AgentKitMarket user found with that email.", 404);
      }

      const memberBody = { userId: resolvedUserId, role: body.role ?? "member" };
      const parsed = addOrgMemberRequestSchema.safeParse(memberBody);

      if (!parsed.success) {
        return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
      }

      const backendBody = { ...parsed.data, actorUserId: user.id };
      return proxyToBackend(marketBackendOrgRoutes.adminOrgMembers(orgId), "POST", backendBody);
    }

    // Legacy path: { userId, role } — kept for any existing API consumers.
    const parsed = addOrgMemberRequestSchema.safeParse(body);

    if (!parsed.success) {
      return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    const backendBody = { ...parsed.data, actorUserId: user.id };
    return proxyToBackend(marketBackendOrgRoutes.adminOrgMembers(orgId), "POST", backendBody);
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Org member — remove
// ---------------------------------------------------------------------------

export async function browserRemoveOrgMember(_request: Request, orgId: string, userId: string) {
  try {
    const user = await requireUserForApi();
    return proxyToBackend(marketBackendOrgRoutes.adminOrgMember(orgId, userId), "DELETE", {
      actorUserId: user.id
    });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Org — delete
// ---------------------------------------------------------------------------

export async function browserDeleteOrg(_request: Request, orgId: string) {
  try {
    const user = await requireUserForApi();
    return proxyToBackend(marketBackendOrgRoutes.adminDeleteOrg(orgId), "DELETE", {
      actorUserId: user.id
    });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Invites — list / accept
// ---------------------------------------------------------------------------

export async function browserListMyOrgInvites() {
  try {
    const user = await requireUserForApi();
    return proxyToBackend(marketBackendOrgRoutes.adminListUserInvites(user.id), "GET");
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

export async function browserAcceptOrgInvite(request: Request, orgId: string) {
  try {
    const user = await requireUserForApi();
    const body = (await request.json()) as unknown;
    const parsed = acceptOrgInviteRequestSchema.safeParse(body);

    if (!parsed.success) {
      return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    return proxyToBackend(marketBackendOrgRoutes.adminAcceptInvite(orgId, user.id), "POST", {});
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Kit operations — transfer / visibility
// ---------------------------------------------------------------------------

export async function browserTransferKit(request: Request, kitId: string) {
  try {
    const user = await requireUserForApi();
    const body = (await request.json()) as unknown;
    const parsed = transferKitRequestSchema.safeParse(body);

    if (!parsed.success) {
      return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    const backendBody = { ...parsed.data, requestedByUserId: user.id };
    return proxyToBackend(marketBackendOrgRoutes.adminTransferKit(kitId), "POST", backendBody);
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

export async function browserSetKitVisibility(request: Request, kitId: string) {
  try {
    const user = await requireUserForApi();
    const body = (await request.json()) as unknown;
    const parsed = setKitVisibilityRequestSchema.safeParse(body);

    if (!parsed.success) {
      return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    const backendBody = { ...parsed.data, requestedByUserId: user.id };
    return proxyToBackend(marketBackendOrgRoutes.adminSetKitVisibility(kitId), "POST", backendBody);
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}
