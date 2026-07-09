/**
 * Browser org helpers — authenticate via AuthKit cookie session (WorkOS browser
 * sessions) instead of the Forge device-auth bearer token.  These back the
 * `/api/orgs/*` and `/api/kits/[slug]/{transfer,visibility}` routes used by the
 * web UI.  The `/api/forge/*` org routes remain unchanged for CLI consumers.
 *
 * P2: AgentKitProfile is the system of record for org ENTITIES (orgs, members,
 * invites, shared provider keys, run budgets), so those proxy to AgentKitProfile's
 * `profileOrgRoutes` (service-key + asserted actor userId). KIT operations
 * (transfer / visibility) are kit-table mutations owned by market-core, so they
 * still proxy to the market backend via `fetchAdminBackend`.
 */

import { NextResponse } from "next/server";
import {
  marketBackendOrgRoutes,
  profileOrgRoutes,
  createOrgRequestSchema,
  addOrgMemberRequestSchema,
  createEmailInviteRequestSchema,
  acceptOrgInviteRequestSchema,
  transferKitRequestSchema,
  setKitVisibilityRequestSchema,
  setOrgApiKeyRequestSchema,
  orgKeyProviderTypeSchema,
  setOrgRunBudgetRequestSchema
} from "@agentkitforge/contracts";
import { fetchAdminBackend } from "@/lib/admin-api";
import { fetchProfileOrg, ProfileOrgConfigError } from "@/lib/profile/profile-org-client";
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
  return mapProxyResponse(backendResponse, backendPath);
}

/**
 * Proxy an org request to AgentKitProfile (the org system of record).
 *   - actorUserId set  → trusted-context (Profile reads the actor from
 *     `x-agentkit-user-id` and enforces owner/admin role gates).
 *   - actorUserId unset → service-context (target ids asserted in the path).
 */
async function proxyToProfile(
  profilePath: string,
  method: string,
  options: { actorUserId?: string; body?: unknown } = {}
): Promise<Response> {
  const profileResponse = await fetchProfileOrg(profilePath, {
    method,
    actorUserId: options.actorUserId,
    body: options.body
  });
  return mapProxyResponse(profileResponse, profilePath);
}

/** Maps an upstream (backend or Profile) response into the browser-facing JSON shape. */
async function mapProxyResponse(upstream: Response, sourcePath: string): Promise<Response> {
  if (upstream.status === 204) {
    return NextResponse.json({}, { status: 204 });
  }

  const text = await upstream.text();
  let payload: unknown;

  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    console.error("[agentkitmarket] browser-orgs upstream non-json", {
      sourcePath,
      status: upstream.status,
      snippet: text.slice(0, 200)
    });
    return browserOrgError("AgentKitMarket could not complete the request.", 500);
  }

  if (!upstream.ok) {
    const message =
      isRecord(payload) && typeof payload.message === "string"
        ? payload.message
        : "AgentKitMarket could not complete the request.";
    return browserOrgError(message, upstream.status);
  }

  return NextResponse.json(payload, { status: upstream.status });
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
  if (error instanceof ProfileOrgConfigError) {
    return browserOrgError("AgentKitMarket server configuration is incomplete.", 503);
  }
  const message = error instanceof Error ? error.message : "Request failed.";
  if (message.includes("Missing ") || message.includes("not configured")) {
    return browserOrgError("AgentKitMarket server configuration is incomplete.", 503);
  }
  return browserOrgError("AgentKitMarket could not complete the request.", 500);
}

// ---------------------------------------------------------------------------
// Orgs — list / create  (AgentKitProfile)
// ---------------------------------------------------------------------------

export async function browserListMyOrgs() {
  try {
    const user = await requireUserForApi();
    // SERVICE-context: target userId asserted in the path.
    return proxyToProfile(profileOrgRoutes.listUserOrgs(user.id), "GET");
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

    // TRUSTED-context: Profile reads ownerUserId from x-agentkit-user-id (the body
    // carries only the org fields).
    return proxyToProfile(profileOrgRoutes.createOrg(), "POST", {
      actorUserId: user.id,
      body: parsed.data
    });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Org members — list / add  (AgentKitProfile)
// ---------------------------------------------------------------------------

export async function browserListOrgMembers(_request: Request, orgId: string) {
  try {
    const user = await requireUserForApi();
    return proxyToProfile(profileOrgRoutes.orgMembers(orgId), "GET", { actorUserId: user.id });
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

      // Not yet a registered AgentKitMarket user → store a pending email invite.
      // It is claimed automatically on that person's first login.
      if (!resolvedUserId) {
        const inviteBody = { email, role: body.role ?? "member" };
        const parsedInvite = createEmailInviteRequestSchema.safeParse(inviteBody);

        if (!parsedInvite.success) {
          return browserOrgError(parsedInvite.error.issues[0]?.message ?? "Invalid request.", 400);
        }

        // TRUSTED-context: actor from header (owner/admin gated by Profile).
        const response = await proxyToProfile(
          profileOrgRoutes.createEmailInvite(orgId),
          "POST",
          { actorUserId: user.id, body: parsedInvite.data }
        );

        // On success, surface a clear "pending" payload so the UI can show the right copy.
        if (response.ok) {
          return NextResponse.json({ pending: true, email }, { status: 201 });
        }
        return response;
      }

      const memberBody = { userId: resolvedUserId, role: body.role ?? "member" };
      const parsed = addOrgMemberRequestSchema.safeParse(memberBody);

      if (!parsed.success) {
        return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
      }

      return proxyToProfile(profileOrgRoutes.orgMembers(orgId), "POST", {
        actorUserId: user.id,
        body: parsed.data
      });
    }

    // Legacy path: { userId, role } — kept for any existing API consumers.
    const parsed = addOrgMemberRequestSchema.safeParse(body);

    if (!parsed.success) {
      return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    return proxyToProfile(profileOrgRoutes.orgMembers(orgId), "POST", {
      actorUserId: user.id,
      body: parsed.data
    });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Org member — remove  (AgentKitProfile)
// ---------------------------------------------------------------------------

export async function browserRemoveOrgMember(_request: Request, orgId: string, userId: string) {
  try {
    const user = await requireUserForApi();
    // TRUSTED-context: actor (owner/admin) from header; path userId is the member removed.
    return proxyToProfile(profileOrgRoutes.orgMember(orgId, userId), "DELETE", {
      actorUserId: user.id
    });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Org — delete  (AgentKitProfile)
// ---------------------------------------------------------------------------

export async function browserDeleteOrg(_request: Request, orgId: string) {
  try {
    const user = await requireUserForApi();
    return proxyToProfile(profileOrgRoutes.deleteOrg(orgId), "DELETE", { actorUserId: user.id });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Invites — list / accept  (AgentKitProfile)
// ---------------------------------------------------------------------------

export async function browserListMyOrgInvites() {
  try {
    const user = await requireUserForApi();
    // SERVICE-context: target userId asserted in the path.
    return proxyToProfile(profileOrgRoutes.listUserInvites(user.id), "GET");
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

    // SERVICE-context: the accepting userId is asserted in the path.
    return proxyToProfile(profileOrgRoutes.acceptInvite(orgId, user.id), "POST", { body: {} });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Kit operations — transfer / visibility  (market backend; kit-table mutations)
//
// These are kit mutations owned by market-core (NOT Profile org entities), so they
// keep proxying to the market backend. market-core enforces authz via its
// Profile-backed OrgLookupClient (fail-closed) server-side.
//
// The browser routes carry the kit's URL SLUG (`/api/kits/[slug]/{transfer,
// visibility}`), not its kit_id, and can't resolve a PRIVATE kit's kit_id via the
// public catalog. So they proxy to the backend `by-slug` variants, which resolve
// slug→kit server-side (mirroring the download-by-slug route). The body's `kitId`
// field is ignored by the backend (it uses the resolved kit).
// ---------------------------------------------------------------------------

export async function browserTransferKit(request: Request, slug: string) {
  try {
    const user = await requireUserForApi();
    const body = (await request.json()) as unknown;
    const parsed = transferKitRequestSchema.safeParse(body);

    if (!parsed.success) {
      return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    const backendBody = { ...parsed.data, actorUserId: user.id };
    return proxyToBackend(marketBackendOrgRoutes.adminTransferKitBySlug(slug), "POST", backendBody);
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

export async function browserSetKitVisibility(request: Request, slug: string) {
  try {
    const user = await requireUserForApi();
    const body = (await request.json()) as unknown;
    const parsed = setKitVisibilityRequestSchema.safeParse(body);

    if (!parsed.success) {
      return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    const backendBody = { ...parsed.data, actorUserId: user.id };
    return proxyToBackend(marketBackendOrgRoutes.adminSetKitVisibilityBySlug(slug), "POST", backendBody);
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Org shared API key — masked status / set / clear  (AgentKitProfile)
// Owner/admin gated by Profile via the trusted-context actor. The raw key is
// NEVER returned to the browser; the status route surfaces only the masked status.
// ---------------------------------------------------------------------------

export async function browserGetOrgApiKeyStatus(_request: Request, orgId: string) {
  try {
    const user = await requireUserForApi();
    return proxyToProfile(profileOrgRoutes.orgApiKeyStatus(orgId), "GET", { actorUserId: user.id });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

export async function browserSetOrgApiKey(request: Request, orgId: string) {
  try {
    const user = await requireUserForApi();
    const body = (await request.json()) as unknown;

    // Validate the incoming browser body WITHOUT actorUserId (the browser never
    // sends it); Profile reads the actor from x-agentkit-user-id. The body carries
    // `providerType` (which provider's key) + apiKey + optional baseUrl.
    const parsed = setOrgApiKeyRequestSchema.omit({ actorUserId: true }).safeParse(body);

    if (!parsed.success) {
      return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    return proxyToProfile(profileOrgRoutes.orgApiKey(orgId), "POST", {
      actorUserId: user.id,
      body: parsed.data
    });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

export async function browserClearOrgApiKey(request: Request, orgId: string) {
  try {
    const user = await requireUserForApi();

    // The provider to clear comes from the request `?providerType=` query param;
    // it is required and forwarded to Profile as a query param.
    const providerType = new URL(request.url).searchParams.get("providerType");
    const parsedProvider = orgKeyProviderTypeSchema.safeParse(providerType);
    if (!parsedProvider.success) {
      return browserOrgError("A valid providerType query param is required.", 400);
    }

    const profilePath = `${profileOrgRoutes.orgApiKey(orgId)}?providerType=${encodeURIComponent(
      parsedProvider.data
    )}`;
    return proxyToProfile(profilePath, "DELETE", { actorUserId: user.id });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

// ---------------------------------------------------------------------------
// Org default run budget — read / set / clear  (AgentKitProfile)
// Owner/admin gated by Profile via the trusted-context actor. The org default
// OVERRIDES each member's own default budget.
// ---------------------------------------------------------------------------

export async function browserGetOrgRunBudget(_request: Request, orgId: string) {
  try {
    const user = await requireUserForApi();
    return proxyToProfile(profileOrgRoutes.orgRunBudget(orgId), "GET", { actorUserId: user.id });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

export async function browserSetOrgRunBudget(request: Request, orgId: string) {
  try {
    const user = await requireUserForApi();
    const body = (await request.json()) as unknown;

    // Validate the browser body WITHOUT actorUserId (the browser never sends it);
    // Profile reads the actor from x-agentkit-user-id.
    const parsed = setOrgRunBudgetRequestSchema.omit({ actorUserId: true }).safeParse(body);
    if (!parsed.success) {
      return browserOrgError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    }

    return proxyToProfile(profileOrgRoutes.orgRunBudget(orgId), "POST", {
      actorUserId: user.id,
      body: parsed.data
    });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}

export async function browserClearOrgRunBudget(_request: Request, orgId: string) {
  try {
    const user = await requireUserForApi();
    return proxyToProfile(profileOrgRoutes.orgRunBudget(orgId), "DELETE", { actorUserId: user.id });
  } catch (error) {
    return handleBrowserOrgException(error);
  }
}
