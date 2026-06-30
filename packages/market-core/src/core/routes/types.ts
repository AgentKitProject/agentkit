/**
 * Runtime-agnostic request/response abstraction for the market core router.
 *
 * The hosted Lambda entrypoint converts an APIGatewayProxyEvent into a
 * CoreRequest and converts the CoreResponse back into an APIGatewayProxyResult.
 * The self-host server entrypoint (Phase 3) does the same with a plain HTTP
 * request. The router and route handlers depend only on these shapes — never on
 * aws-lambda types.
 */

import type {
  AdminRepository,
  AuditRepository,
  CatalogRepository,
  EntitlementRepository,
  FavoritesRepository,
  ObjectStore,
  OrgLookupClient,
  OrgRepository,
  PackageUploadService,
} from '../ports.js';
import type { KitRecord } from '../types.js';

/** A normalized inbound request, decoupled from any HTTP/Lambda runtime. */
export interface CoreRequest {
  method: string;
  /** The matched route template, e.g. '/kits/{slug}' (API Gateway `resource`). */
  resource: string;
  /** Path parameters, e.g. { slug: 'my-kit' }. */
  pathParameters: Record<string, string | undefined> | null;
  /** Query-string parameters. */
  queryStringParameters: Record<string, string | undefined> | null;
  /** Request headers (case-insensitive lookup is performed by the router). */
  headers: Record<string, string | undefined>;
  /** Already-decoded raw request body string (or null). */
  body: string | null;
  /** Whether `body` is base64-encoded (Lambda may set this). */
  isBase64Encoded?: boolean;
}

/** A normalized response the entrypoint serializes for its runtime. */
export interface CoreResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Optional commercial route extension (loaded only when
 * `@agentkit-commercial/market-core` is present). It owns the Tier-2 paid/
 * licensed-kit + Stripe-payout routes and the paid-kit download gate. When this
 * is absent the public router runs the free path only: all paid routes 404 and
 * every kit is treated as downloadable.
 */
export interface CommercialRouter {
  /**
   * Attempts to handle a request. Returns a CoreResponse if this route belongs
   * to the commercial surface, or `undefined` if it does not own the route (so
   * the public router falls through to its 404).
   */
  handle(request: CoreRequest, deps: RouterDeps): Promise<CoreResponse | undefined>;
  /**
   * Whether a kit must NOT be served via the public presigned download (paid,
   * non-downloadable). Absent ⇒ never gated ⇒ free downloads always work.
   */
  isDownloadGated?(kit: KitRecord): boolean;
}

/** Dependencies injected into the router (repositories/services + config). */
export interface RouterDeps {
  repository: CatalogRepository;
  adminRepository?: AdminRepository;
  orgRepository?: OrgRepository;
  /**
   * Read-only org/membership lookups for the kit-coupling handlers, served by
   * AgentKitProfile (system of record for orgs). When present, the kit-coupling
   * authz/owner-org paths use THIS (fail-closed) instead of `orgRepository`. The
   * org CRUD routes + kit mutations still use `orgRepository`. Absent ⇒ those
   * paths fall back to `orgRepository` (pre-P2 behavior).
   */
  orgLookupClient?: OrgLookupClient;
  /** Tier-2 buyer entitlements (paid kits). Provided by the commercial composition root. */
  entitlementRepository?: EntitlementRepository;
  /** Cloud-synced kit-reference favorites. */
  favoritesRepository?: FavoritesRepository;
  /** Append-only audit log of significant mutations (admin-only reads). */
  auditRepository?: AuditRepository;
  packageUploadService?: PackageUploadService;
  /** Object store for reading kit packages (Tier-2 watermarked licensed-package fetch). */
  objectStore?: ObjectStore;
  /**
   * Optional commercial route extension. When present, the public router defers
   * unmatched admin/user routes to it before the final 404, and uses its
   * `isDownloadGated` hook for the paid-kit public-download guard.
   */
  commercial?: CommercialRouter;
  allowedOrigins?: string[];
  adminKey?: string;
}
