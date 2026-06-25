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
import { requireForgeUser } from "@/lib/forge-auth";
import { forgeSubmissionError, forgeSubmissionException } from "@/lib/forge-route-errors";

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
    console.error("[agentkitmarket] forge-orgs backend non-json", { backendPath, status: backendResponse.status, snippet: text.slice(0, 200) });
    return forgeSubmissionError("MARKET_BACKEND_ERROR", "AgentKitMarket could not complete the request.", 500);
  }

  if (!backendResponse.ok) {
    const message =
      isRecord(payload) && typeof payload.message === "string"
        ? payload.message
        : "AgentKitMarket could not complete the request.";
    return forgeSubmissionError(httpCodeToCode(backendResponse.status), message, backendResponse.status);
  }

  return NextResponse.json(payload, { status: backendResponse.status });
}

function httpCodeToCode(status: number): string {
  if (status === 400) return "BAD_REQUEST";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  return "MARKET_BACKEND_ERROR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Orgs — list / create
// ---------------------------------------------------------------------------

export async function listMyOrgs(request: Request) {
  try {
    const user = await requireForgeUser(request);
    return proxyToBackend(marketBackendOrgRoutes.adminListUserOrgs(user.id), "GET");
  } catch (error) {
    return forgeSubmissionException(error, "/api/forge/orgs");
  }
}

export async function createOrg(request: Request) {
  try {
    const user = await requireForgeUser(request);
    const body = (await request.json()) as unknown;
    const parsed = createOrgRequestSchema.safeParse(body);

    if (!parsed.success) {
      return forgeSubmissionError("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    const backendBody = { ...parsed.data, ownerUserId: user.id };
    return proxyToBackend(marketBackendOrgRoutes.adminCreateOrg(), "POST", backendBody);
  } catch (error) {
    return forgeSubmissionException(error, "/api/forge/orgs");
  }
}

// ---------------------------------------------------------------------------
// Org kits — list (members only, incl private)
// ---------------------------------------------------------------------------

export async function listOrgKits(request: Request, orgId: string) {
  try {
    const user = await requireForgeUser(request);
    return proxyToBackend(
      `${marketBackendOrgRoutes.adminListOrgKits(orgId)}?actorUserId=${encodeURIComponent(user.id)}`,
      "GET"
    );
  } catch (error) {
    return forgeSubmissionException(error, `/api/forge/orgs/${orgId}/kits`);
  }
}

// ---------------------------------------------------------------------------
// Org members — list / add
// ---------------------------------------------------------------------------

export async function listOrgMembers(request: Request, orgId: string) {
  try {
    await requireForgeUser(request);
    return proxyToBackend(marketBackendOrgRoutes.adminOrgMembers(orgId), "GET");
  } catch (error) {
    return forgeSubmissionException(error, `/api/forge/orgs/${orgId}/members`);
  }
}

export async function addOrgMember(request: Request, orgId: string) {
  try {
    const user = await requireForgeUser(request);
    const body = (await request.json()) as unknown;
    const parsed = addOrgMemberRequestSchema.safeParse(body);

    if (!parsed.success) {
      return forgeSubmissionError("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    const backendBody = { ...parsed.data, invitedByUserId: user.id };
    return proxyToBackend(marketBackendOrgRoutes.adminOrgMembers(orgId), "POST", backendBody);
  } catch (error) {
    return forgeSubmissionException(error, `/api/forge/orgs/${orgId}/members`);
  }
}

// ---------------------------------------------------------------------------
// Org member — remove
// ---------------------------------------------------------------------------

export async function removeOrgMember(request: Request, orgId: string, userId: string) {
  try {
    await requireForgeUser(request);
    return proxyToBackend(marketBackendOrgRoutes.adminOrgMember(orgId, userId), "DELETE");
  } catch (error) {
    return forgeSubmissionException(error, `/api/forge/orgs/${orgId}/members/${userId}`);
  }
}

// ---------------------------------------------------------------------------
// Org — delete
// ---------------------------------------------------------------------------

export async function deleteOrg(request: Request, orgId: string) {
  try {
    const user = await requireForgeUser(request);
    return proxyToBackend(marketBackendOrgRoutes.adminDeleteOrg(orgId), "DELETE", {
      actorUserId: user.id
    });
  } catch (error) {
    return forgeSubmissionException(error, `/api/forge/orgs/${orgId}`);
  }
}

// ---------------------------------------------------------------------------
// Invites — list / accept
// ---------------------------------------------------------------------------

export async function listMyOrgInvites(request: Request) {
  try {
    const user = await requireForgeUser(request);
    return proxyToBackend(marketBackendOrgRoutes.adminListUserInvites(user.id), "GET");
  } catch (error) {
    return forgeSubmissionException(error, "/api/forge/orgs/invites");
  }
}

export async function acceptOrgInvite(request: Request, orgId: string) {
  try {
    const user = await requireForgeUser(request);
    const body = (await request.json()) as unknown;
    const parsed = acceptOrgInviteRequestSchema.safeParse(body);

    if (!parsed.success) {
      return forgeSubmissionError("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    return proxyToBackend(marketBackendOrgRoutes.adminAcceptInvite(orgId, user.id), "POST", {});
  } catch (error) {
    return forgeSubmissionException(error, `/api/forge/orgs/${orgId}/invites/accept`);
  }
}

// ---------------------------------------------------------------------------
// Kit operations — transfer / visibility
// ---------------------------------------------------------------------------

export async function transferKit(request: Request, kitId: string) {
  try {
    const user = await requireForgeUser(request);
    const body = (await request.json()) as unknown;
    const parsed = transferKitRequestSchema.safeParse(body);

    if (!parsed.success) {
      return forgeSubmissionError("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    const backendBody = { ...parsed.data, requestedByUserId: user.id };
    return proxyToBackend(marketBackendOrgRoutes.adminTransferKit(kitId), "POST", backendBody);
  } catch (error) {
    return forgeSubmissionException(error, `/api/forge/kits/${kitId}/transfer`);
  }
}

export async function setKitVisibility(request: Request, kitId: string) {
  try {
    const user = await requireForgeUser(request);
    const body = (await request.json()) as unknown;
    const parsed = setKitVisibilityRequestSchema.safeParse(body);

    if (!parsed.success) {
      return forgeSubmissionError("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    const backendBody = { ...parsed.data, requestedByUserId: user.id };
    return proxyToBackend(marketBackendOrgRoutes.adminSetKitVisibility(kitId), "POST", backendBody);
  } catch (error) {
    return forgeSubmissionException(error, `/api/forge/kits/${kitId}/visibility`);
  }
}
