import { z } from "zod";

/**
 * AgentKitMarket Tier-2 paid/licensed-kit contracts (Market Phase 2).
 *
 * Seam B (market-app ↔ agentkitmarket-infra backend): admin-key authenticated
 * routes for setting kit pricing/license, granting/checking entitlements, and
 * fetching the per-buyer watermarked package.
 *
 * Phase A (this slice): no payment provider. Entitlements are created by
 * admin/free grants or manual testing; Stripe webhooks call the same grant
 * route in Phase B. Core stays payment-provider-agnostic.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const kitPricingSchema = z.enum(["free", "paid"]);
export type KitPricing = z.infer<typeof kitPricingSchema>;

export const priceModelSchema = z.enum(["one_time", "subscription"]);
export type PriceModel = z.infer<typeof priceModelSchema>;

export const priceIntervalSchema = z.enum(["month", "year"]);
export type PriceInterval = z.infer<typeof priceIntervalSchema>;

export const kitCurrencySchema = z.enum(["USD"]);
export type KitCurrency = z.infer<typeof kitCurrencySchema>;

export const licenseTypeSchema = z.enum(["default", "custom"]);
export type LicenseType = z.infer<typeof licenseTypeSchema>;

export const entitlementStatusSchema = z.enum(["active", "revoked", "expired"]);
export type EntitlementStatus = z.infer<typeof entitlementStatusSchema>;

export const entitlementSourceSchema = z.enum(["purchase", "admin_grant", "free"]);
export type EntitlementSource = z.infer<typeof entitlementSourceSchema>;

/** The default platform EULA version id applied when licenseType === 'default'. */
export const DEFAULT_KIT_LICENSE_VERSION = "default-v1" as const;

// ---------------------------------------------------------------------------
// Object schemas
// ---------------------------------------------------------------------------

/** Pricing + license metadata carried on a kit. All optional/defaulted (free-safe). */
export const kitPricingMetadataSchema = z.object({
  pricing: kitPricingSchema.default("free"),
  priceModel: priceModelSchema.optional(),
  priceCents: z.number().int().nonnegative().optional(),
  currency: kitCurrencySchema.default("USD"),
  interval: priceIntervalSchema.optional(),
  /**
   * Optional subscription free-trial length in days. Only meaningful when
   * priceModel === 'subscription'; ignored/zeroed otherwise. Maps to Stripe's
   * subscription `trial_period_days` at checkout.
   */
  trialDays: z.number().int().nonnegative().optional(),
  /** Paid kits default false (online-only); free kits are treated as downloadable. */
  downloadable: z.boolean().optional(),
  licenseType: licenseTypeSchema.default("default"),
  licenseText: z.string().optional(),
  licenseVersion: z.string().optional()
});
export type KitPricingMetadata = z.infer<typeof kitPricingMetadataSchema>;

export const entitlementSchema = z.object({
  entitlementId: z.string().min(1),
  kitId: z.string().min(1),
  userId: z.string().min(1),
  status: entitlementStatusSchema,
  source: entitlementSourceSchema,
  licenseVersion: z.string().min(1),
  licenseAcceptedAt: z.string(),
  licenseTextSnapshot: z.string(),
  grantedAt: z.string(),
  expiresAt: z.string().optional(),
  stripeSubscriptionId: z.string().nullable().optional()
});
export type Entitlement = z.infer<typeof entitlementSchema>;

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * POST /admin/kits/{kitId}/pricing. actorUserId must be the kit owner or an
 * admin/owner of the kit's owning org (role-gated server-side).
 * Validation: paid requires priceCents>0 and priceModel; subscription requires interval.
 */
export const setKitPricingRequestSchema = z.object({
  actorUserId: z.string().min(1),
  pricing: kitPricingSchema,
  priceModel: priceModelSchema.optional(),
  priceCents: z.number().int().nonnegative().optional(),
  currency: kitCurrencySchema.optional(),
  interval: priceIntervalSchema.optional(),
  /** Subscription free-trial length in days; only meaningful for subscription kits. */
  trialDays: z.number().int().nonnegative().optional(),
  downloadable: z.boolean().optional(),
  licenseType: licenseTypeSchema.optional(),
  licenseText: z.string().optional()
});
export type SetKitPricingRequest = z.infer<typeof setKitPricingRequestSchema>;

/** POST /admin/kits/{kitId}/entitlements — grant. Idempotent on (userId,kitId). */
export const grantEntitlementRequestSchema = z.object({
  userId: z.string().min(1),
  source: entitlementSourceSchema,
  licenseVersion: z.string().min(1),
  licenseAcceptedAt: z.string().min(1),
  licenseTextSnapshot: z.string(),
  expiresAt: z.string().optional(),
  stripeSubscriptionId: z.string().nullable().optional()
});
export type GrantEntitlementRequest = z.infer<typeof grantEntitlementRequestSchema>;

/**
 * POST /admin/entitlements/by-subscription/{stripeSubscriptionId}/status —
 * subscription lifecycle. Driven by the Stripe webhook (subscription.updated /
 * subscription.deleted): sets the status (and optional expiresAt) of every
 * entitlement carrying the given Stripe subscription id. Idempotent.
 */
export const setEntitlementSubscriptionStatusRequestSchema = z.object({
  status: entitlementStatusSchema,
  expiresAt: z.string().optional()
});
export type SetEntitlementSubscriptionStatusRequest = z.infer<
  typeof setEntitlementSubscriptionStatusRequestSchema
>;

/** POST /admin/kits/{kitId}/licensed-package — entitlement-gated watermarked fetch. */
export const licensedPackageRequestSchema = z.object({
  userId: z.string().min(1)
});
export type LicensedPackageRequest = z.infer<typeof licensedPackageRequestSchema>;

/** Response from the licensed-package route: base64 watermarked bytes + metadata. */
export const licensedPackageResponseSchema = z.object({
  kitId: z.string().min(1),
  userId: z.string().min(1),
  entitlementId: z.string().min(1),
  fileName: z.string().min(1),
  contentBase64: z.string(),
  sha256: z.string(),
  licenseVersion: z.string().min(1),
  watermark: z.object({
    entitlementId: z.string(),
    userId: z.string(),
    kitId: z.string(),
    grantedAt: z.string(),
    hash: z.string()
  })
});
export type LicensedPackageResponse = z.infer<typeof licensedPackageResponseSchema>;

export const listEntitlementsResponseSchema = z.object({
  items: z.array(entitlementSchema)
});
export type ListEntitlementsResponse = z.infer<typeof listEntitlementsResponseSchema>;

// ---------------------------------------------------------------------------
// Online-only (output-only) run directive — M6 Slice 1.
//
// A PROTECTED kit (paid && !downloadable, i.e. `isOnlineOnly`) must NEVER hand
// its instruction CONTENT to a CLIENT (desktop app, browser, CLI). The ONLY
// legitimate way to use it is to RUN it server-side (web Forge or Auto) and get
// OUTPUT back — never the kit files. When a client requests the licensed package
// for such a kit, the licensed-package route refuses with HTTP 402 and returns
// THIS directive INSTEAD of `contentBase64`.
//
// MOAT: this directive carries NO pricing, watermark, entitlement, or license
// VALUES — only the public identifiers and the public run-target URLs. All
// commercial/entitlement/watermark logic stays in agentkit-commercial.
// ---------------------------------------------------------------------------

/** Discriminator code for the output-only run directive (HTTP 402 body). */
export const ONLINE_ONLY_RUN_REQUIRED = "online_only_run_required" as const;

/**
 * Public run targets where a protected kit can be RUN (not downloaded). Both are
 * OPTIONAL: on self-host they are omitted (no phone-home to the hosted ecosystem).
 */
export const onlineOnlyRunTargetsSchema = z.object({
  /** Public web-Forge run URL, if the instance exposes one. */
  forgeWebUrl: z.string().optional(),
  /** Public AgentKitAuto run URL, if the instance exposes one. */
  autoUrl: z.string().optional()
});
export type OnlineOnlyRunTargets = z.infer<typeof onlineOnlyRunTargetsSchema>;

/**
 * The HTTP-402 body returned IN PLACE OF licensed-package bytes when a CLIENT
 * requests a protected (online-only) kit. The server returns OUTPUT-only run
 * guidance; the kit content is never serialized into this shape.
 */
export const onlineOnlyRunDirectiveSchema = z.object({
  onlineOnly: z.literal(true),
  code: z.literal(ONLINE_ONLY_RUN_REQUIRED),
  /** Public Market slug of the protected kit. */
  slug: z.string().min(1),
  /** Canonical Market kit id, if resolved. */
  kitId: z.string().optional(),
  /** Human-readable, content-free explanation. */
  message: z.string().min(1),
  /** Public URLs where the kit can be RUN (omitted/undefined on self-host). */
  runTargets: onlineOnlyRunTargetsSchema.optional()
});
export type OnlineOnlyRunDirective = z.infer<typeof onlineOnlyRunDirectiveSchema>;

// ---------------------------------------------------------------------------
// Seam S (web-forge ↔ market-app, SERVICE-KEY auth) — protected-kit resolution
// for the hosted AgentKitAuto worker path.
//
// THIRD auth path on market-app's /api/forge surface — NOT the AuthKit cookie,
// NOT the Forge device-auth bearer (requireForgeUser). The web-forge SSR server
// (NOT the worker, NOT a browser) asserts an entitled user's id with a shared
// service key so it can fetch the SAME licensed package the user-authed
// /api/forge/kits/{slug}/licensed-package route returns, WITHOUT the user's live
// session — while entitlement is STILL enforced server-side (Market verifies the
// asserted userId is entitled). The service key removes the SESSION requirement,
// never the ENTITLEMENT requirement.
// ---------------------------------------------------------------------------

/** Header carrying the web-forge↔market-app shared service key (constant-time
 *  compared server-side). Value lives in MARKET_SERVICE_KEY on BOTH sides; it is
 *  server-only and never shipped to a browser bundle or to Forge/the worker. */
export const marketServiceAuthHeader = "x-agentkit-service-key" as const;

/** Error codes returned by the service licensed-package endpoint. */
export const serviceLicensedPackageErrorSchema = z.enum([
  /** Service key env unset on the provider → endpoint disabled (503). */
  "unconfigured",
  /** Missing/!match service key (401). */
  "unauthorized",
  /** Asserted user holds no active entitlement for this kit (403). */
  "not_entitled",
  /** Kit (slug/kitId) not found (404). */
  "not_found",
  /** Malformed request body (400). */
  "invalid_request",
  /** Upstream Market backend failure (502). */
  "backend_unavailable"
]);
export type ServiceLicensedPackageError = z.infer<typeof serviceLicensedPackageErrorSchema>;

/**
 * POST {marketServiceRoutes.licensedPackage(slug)} body. Asserts the entitled
 * user's id (no session). `slug` is the path param; `kitId` may be supplied to
 * skip the slug→kitId resolution (optional, advisory). At least the path slug
 * always identifies the kit.
 */
export const serviceLicensedPackageRequestSchema = z.object({
  userId: z.string().min(1),
  kitId: z.string().min(1).optional()
});
export type ServiceLicensedPackageRequest = z.infer<typeof serviceLicensedPackageRequestSchema>;

/**
 * Response from the service licensed-package endpoint — the SAME watermarked
 * licensed-package payload the user-authed forge route returns (base64 bytes +
 * watermark + sha256), plus the resolved kit context fields (slug/pricing/
 * downloadable/onlineOnly) the consumer uses to enforce no-persist. The bytes
 * are held in memory only and never persisted; never log this payload.
 */
export const serviceLicensedPackageResponseSchema = licensedPackageResponseSchema.extend({
  slug: z.string().min(1),
  pricing: kitPricingSchema,
  downloadable: z.boolean(),
  onlineOnly: z.boolean()
});
export type ServiceLicensedPackageResponse = z.infer<typeof serviceLicensedPackageResponseSchema>;

// ---------------------------------------------------------------------------
// Service "entitled kits" listing (Seam S — web-forge/Auto ↔ market-app,
// SERVICE-KEY auth). M6 Slice 3: the buyer entry point on AgentKitAuto.
//
// The Auto SSR server (NOT a browser, NOT the worker) asserts the current user's
// id with MARKET_SERVICE_KEY and asks Market for the BROWSER-SAFE list of that
// user's PROTECTED (paid + non-downloadable) entitled kits, so the Auto UI can
// offer a "run this kit on Auto" picker WITHOUT ever receiving entitlement-table
// internals or kit content. Market resolves entitlements → catalog records
// server-side and returns ONLY public display fields (name/slug/marketKitId).
//
// Why a NEW seam (not forgeListMyEntitlements): that route is device-auth bearer
// and returns raw entitlements (kitId only, no slug/name, unfiltered by
// pricing). Auto-web has no user bearer to forward server-side; it asserts the
// userId via the service key (session removed, entitlement STILL enforced — only
// active entitlements for protected kits are returned).
// ---------------------------------------------------------------------------

/** Error codes returned by the service entitled-kits listing endpoint. */
export const serviceEntitledKitsErrorSchema = z.enum([
  /** Service key env unset on the provider → endpoint disabled (503). */
  "unconfigured",
  /** Missing/!match service key (401). */
  "unauthorized",
  /** Malformed request body (400). */
  "invalid_request",
  /** Upstream Market backend failure (502). */
  "backend_unavailable"
]);
export type ServiceEntitledKitsError = z.infer<typeof serviceEntitledKitsErrorSchema>;

/**
 * POST {marketServiceRoutes.entitledKits()} body. Asserts the entitled user's id
 * (no session). The provider lists that user's active entitlements and resolves
 * them against the catalog server-side.
 */
export const serviceEntitledKitsRequestSchema = z.object({
  userId: z.string().min(1)
});
export type ServiceEntitledKitsRequest = z.infer<typeof serviceEntitledKitsRequestSchema>;

/**
 * One PROTECTED entitled kit, BROWSER-SAFE. Carries ONLY public display fields —
 * never entitlement ids, license text, watermark, or kit content. `marketKitId`
 * + `slug` are exactly what Auto needs to build a `kitRef:{source:"market",...}`.
 */
export const serviceEntitledKitSchema = z.object({
  /** Canonical Market kit id (→ kitRef.marketKitId). */
  marketKitId: z.string().min(1),
  /** Market slug, the Market service lookup key (→ kitRef.slug). */
  slug: z.string().min(1),
  /** Public display name. */
  name: z.string().min(1)
});
export type ServiceEntitledKit = z.infer<typeof serviceEntitledKitSchema>;

/**
 * Response from the service entitled-kits endpoint: the user's PROTECTED
 * (paid + non-downloadable) entitled kits, browser-safe. Free/downloadable
 * entitlements are EXCLUDED (they don't need an Auto run — they download). An
 * entitlement whose kit can't be resolved in the catalog is dropped silently.
 */
export const serviceEntitledKitsResponseSchema = z.object({
  kits: z.array(serviceEntitledKitSchema)
});
export type ServiceEntitledKitsResponse = z.infer<typeof serviceEntitledKitsResponseSchema>;

/**
 * POST {marketServiceRoutes.resolveOrgApiKey()} body. Asserts the user's id (no
 * session) and the `providerType` the consumer wants a key for. The Market
 * service maps the user → their single team org that holds a shared API key FOR
 * THAT PROVIDER (server-side rule) and returns the decrypted key. Auto / Forge
 * call this at inference time, AFTER a member's own key, BEFORE the operator key.
 * `providerType` is the 5-value `orgKeyProviderTypeSchema` from orgs.ts (mirrored
 * as a string here to avoid a cross-file import; the backend validates it).
 * Response = resolvedOrgApiKeySchema (orgs.ts): { found, orgId?, apiKey?, ... }.
 */
export const serviceResolveOrgApiKeyRequestSchema = z.object({
  userId: z.string().min(1),
  providerType: z.string().min(1)
});
export type ServiceResolveOrgApiKeyRequest = z.infer<typeof serviceResolveOrgApiKeyRequestSchema>;

/**
 * POST {marketServiceRoutes.resolveOrgRunBudget()} body. Asserts the user's id
 * (no session). The Market service maps the user → their single org that has a
 * default run budget set (server-side rule) and returns it. Auto calls this at
 * run-create time, AFTER the user's own default and BEFORE the system fallback.
 * Response = resolvedOrgRunBudgetSchema (orgs.ts): { found, budgetCents? }.
 */
export const serviceResolveOrgRunBudgetRequestSchema = z.object({
  userId: z.string().min(1)
});
export type ServiceResolveOrgRunBudgetRequest = z.infer<typeof serviceResolveOrgRunBudgetRequestSchema>;

// ---------------------------------------------------------------------------
// Route builder (Seam S — web-forge ↔ market-app, service-key auth)
// ---------------------------------------------------------------------------

export const marketServiceRoutes = {
  /** POST /api/forge/service/kits/{slug}/licensed-package — service-key authed,
   *  entitlement-gated, asserts userId. */
  licensedPackage: (slug: string) =>
    `/api/forge/service/kits/${encodeURIComponent(slug)}/licensed-package`,
  /** POST /api/forge/service/me/entitled-kits — service-key authed, asserts
   *  userId; returns the user's PROTECTED entitled kits (browser-safe). */
  entitledKits: () => `/api/forge/service/me/entitled-kits`,
  /** POST /api/forge/service/me/org-api-key — service-key authed, asserts userId;
   *  resolves the user's effective org shared API key (decrypted) or { found:false }. */
  resolveOrgApiKey: () => `/api/forge/service/me/org-api-key`,
  /** POST /api/forge/service/me/run-budget — service-key authed, asserts userId;
   *  resolves the user's effective org default run budget or { found:false }. */
  resolveOrgRunBudget: () => `/api/forge/service/me/run-budget`
} as const;

// ---------------------------------------------------------------------------
// Route builders (Seam B — market-app ↔ agentkitmarket-infra, admin-key auth)
// ---------------------------------------------------------------------------

export const marketBackendPricingRoutes = {
  /** POST /admin/kits/{kitId}/pricing */
  adminSetKitPricing: (kitId: string) =>
    `/admin/kits/${encodeURIComponent(kitId)}/pricing`,
  /** GET /admin/users/{userId}/entitlements */
  adminListUserEntitlements: (userId: string) =>
    `/admin/users/${encodeURIComponent(userId)}/entitlements`,
  /** GET /admin/kits/{kitId}/entitlements/{userId} */
  adminGetEntitlement: (kitId: string, userId: string) =>
    `/admin/kits/${encodeURIComponent(kitId)}/entitlements/${encodeURIComponent(userId)}`,
  /** POST /admin/kits/{kitId}/entitlements */
  adminGrantEntitlement: (kitId: string) =>
    `/admin/kits/${encodeURIComponent(kitId)}/entitlements`,
  /** POST /admin/entitlements/by-subscription/{stripeSubscriptionId}/status */
  adminSetEntitlementSubscriptionStatus: (stripeSubscriptionId: string) =>
    `/admin/entitlements/by-subscription/${encodeURIComponent(stripeSubscriptionId)}/status`,
  /** POST /admin/kits/{kitId}/licensed-package */
  adminLicensedPackage: (kitId: string) =>
    `/admin/kits/${encodeURIComponent(kitId)}/licensed-package`
} as const;

// ---------------------------------------------------------------------------
// Route builders (Seam A — Forge ↔ market-app, Bearer auth; for later CLI use)
// ---------------------------------------------------------------------------

export const forgePricingRoutes = {
  /** GET /api/forge/me/entitlements — list the authenticated user's entitlements. */
  myEntitlements: () => "/api/forge/me/entitlements",
  /** POST /api/forge/kits/{slug}/licensed-package — entitlement-gated fetch. */
  licensedPackage: (slug: string) =>
    `/api/forge/kits/${encodeURIComponent(slug)}/licensed-package`
} as const;
