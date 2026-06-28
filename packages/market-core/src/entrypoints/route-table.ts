/**
 * Maps a concrete HTTP path to the API Gateway-style `resource` template +
 * `pathParameters` that the runtime-agnostic router dispatches on. This keeps the
 * router identical between the hosted Lambda (where API Gateway supplies
 * `event.resource`/`event.pathParameters`) and the self-host HTTP server.
 *
 * The table mirrors EXACTLY the resources handled in core/routes/index.ts. An
 * unmatched path returns the raw pathname as `resource` so the router's 404
 * fallback applies.
 */

export interface RoutePattern {
  method: string;
  /** Segments; a segment wrapped in `{}` is a path parameter. */
  template: string;
}

export const ROUTES: RoutePattern[] = [
  { method: 'GET', template: '/health' },
  { method: 'GET', template: '/kits' },
  { method: 'GET', template: '/kits/{slug}' },
  { method: 'POST', template: '/admin/submissions/upload-url' },
  { method: 'POST', template: '/admin/submissions/{submissionId}/validate' },
  { method: 'POST', template: '/admin/submissions/{submissionId}/approve' },
  { method: 'POST', template: '/admin/submissions/{submissionId}/reject' },
  { method: 'POST', template: '/admin/submissions/{submissionId}/archive' },
  { method: 'POST', template: '/admin/submissions/{submissionId}/remove' },
  { method: 'POST', template: '/admin/submissions/{submissionId}/publish' },
  { method: 'GET', template: '/admin/submissions' },
  { method: 'GET', template: '/admin/submissions/{submissionId}' },
  { method: 'POST', template: '/users/submissions/{submissionId}/cancel' },
  { method: 'POST', template: '/admin/kits/{kitId}/hide' },
  { method: 'POST', template: '/admin/kits/{kitId}/unhide' },
  { method: 'POST', template: '/admin/kits/{kitId}/remove' },
  { method: 'POST', template: '/users/kits/{kitId}/remove' },
  { method: 'POST', template: '/admin/kits/{kitId}/download-url' },
  { method: 'POST', template: '/admin/kits/by-slug/{slug}/download-url' },
  // Organizations (Market Phase 2, Seam B).
  { method: 'POST', template: '/admin/orgs' },
  { method: 'DELETE', template: '/admin/orgs/{orgId}' },
  { method: 'GET', template: '/admin/users/{userId}/orgs' },
  { method: 'GET', template: '/admin/orgs/{orgId}/kits' },
  { method: 'GET', template: '/admin/orgs/{orgId}/members' },
  { method: 'POST', template: '/admin/orgs/{orgId}/members' },
  { method: 'DELETE', template: '/admin/orgs/{orgId}/members/{userId}' },
  { method: 'GET', template: '/admin/users/{userId}/invites' },
  { method: 'POST', template: '/admin/users/{userId}/invites/claim' },
  { method: 'POST', template: '/admin/orgs/{orgId}/invites/email' },
  { method: 'POST', template: '/admin/orgs/{orgId}/invites/{userId}/accept' },
  { method: 'POST', template: '/admin/kits/{kitId}/transfer' },
  { method: 'POST', template: '/admin/kits/{kitId}/visibility' },
  // NOTE: Tier-2 paid/licensed-kit + Stripe-payout route templates live in
  // @agentkit-commercial/market-core (registered by the commercial router); they
  // are intentionally absent here so the free build carries no paid surface.
  // Favorites (cloud-synced kit references, Seam B).
  { method: 'GET', template: '/admin/users/{userId}/favorites' },
  { method: 'POST', template: '/admin/users/{userId}/favorites' },
  { method: 'DELETE', template: '/admin/users/{userId}/favorites/{kitId}' },
  // Audit log (admin-only, Seam B).
  { method: 'GET', template: '/admin/audit-logs' },
];

export interface MatchedRoute {
  resource: string;
  pathParameters: Record<string, string | undefined> | null;
}

/**
 * Matches a concrete method+path to a route template + path parameters. The
 * optional `extraRoutes` lets an entrypoint inject the commercial route
 * templates (from @agentkit-commercial/market-core) so the commercial router can
 * dispatch on `request.resource` exactly as the free routes do. Extra routes are
 * tried after the public table; an unmatched path returns the raw pathname.
 */
export function matchRoute(method: string, pathname: string, extraRoutes: RoutePattern[] = []): MatchedRoute {
  const requestSegments = splitPath(pathname);

  for (const route of [...ROUTES, ...extraRoutes]) {
    if (route.method !== method) {
      continue;
    }
    const templateSegments = splitPath(route.template);
    if (templateSegments.length !== requestSegments.length) {
      continue;
    }

    const pathParameters: Record<string, string | undefined> = {};
    let matched = true;
    for (let i = 0; i < templateSegments.length; i += 1) {
      const templateSegment = templateSegments[i]!;
      const requestSegment = requestSegments[i]!;
      if (templateSegment.startsWith('{') && templateSegment.endsWith('}')) {
        pathParameters[templateSegment.slice(1, -1)] = decodeURIComponent(requestSegment);
      } else if (templateSegment !== requestSegment) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return {
        resource: route.template,
        pathParameters: Object.keys(pathParameters).length > 0 ? pathParameters : null,
      };
    }
  }

  return { resource: pathname, pathParameters: null };
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}
