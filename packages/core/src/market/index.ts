/**
 * `@agentkitforge/core/market` — hosted-AgentKitMarket integration.
 *
 * Phase 1 (this module): the AUTH FOUNDATION — cross-platform token storage,
 * WorkOS device-auth login, proactive refresh, and pure expiry helpers.
 *
 * This is the ONLY place in the package that performs network/auth work. The
 * pure spec engine (validate/package/export) must never import from here.
 *
 * Phase 2 (this update): the MARKET OPERATIONS — submit / download / import,
 * ported from the Rust hosted-Market client. These reuse the pure spec engine
 * for validate/package/inspect; the engine never imports back into this module.
 *
 * Later phases will add CLI commands and app integration.
 */

export type {
  StoredSession,
  TokenStore,
  WorkosUser
} from "./types.js";

export {
  ACCESS_TOKEN_REFRESH_BUFFER_SECONDS,
  decodeJwtExp,
  epochSeconds,
  isTokenExpired,
  tokenNeedsRefresh
} from "./jwt.js";

export {
  configDir,
  createDefaultTokenStore,
  FileTokenStore,
  SERVICE_NAME,
  SESSION_ACCOUNT,
  type FileTokenStoreOptions
} from "./store.js";

export {
  WORKOS_DEVICE_AUTH_SCOPE,
  WORKOS_DEVICE_AUTH_URL,
  WORKOS_DEVICE_TOKEN_URL,
  buildDeviceAuthorizationRequest,
  buildDeviceTokenRequest,
  buildRefreshTokenRequest,
  parseDeviceAuthorizationResponse,
  parseDeviceTokenResponse,
  type DeviceAuthorizationResponse,
  type DeviceTokenResponse,
  type WorkosConfig,
  type WorkosHttpRequest
} from "./workos.js";

export {
  ensureAccessToken,
  login,
  logout,
  refreshAccessToken,
  ReconnectRequiredError,
  RECONNECT_REQUIRED_ERROR,
  type DeviceLoginPrompt,
  type EnsureAccessTokenOptions,
  type LoginOptions,
  type LoginResult,
  type RefreshOptions
} from "./auth.js";

export {
  authedRequest,
  normalizeMarketBaseUrl,
  DEFAULT_MARKET_BASE_URL,
  type FetchLike,
  type FetchLikeResponse,
  type MarketRequestOptions
} from "./http.js";

export {
  forgeMarketRoutes,
  forgePricingRoutes,
  forgeFavoriteRoutes
} from "./routes.js";

export {
  listFavorites,
  addFavorite,
  removeFavorite,
  normalizeFavorite,
  type Favorite,
  type FavoriteTarget,
  type ListFavoritesOptions,
  type AddFavoriteOptions,
  type RemoveFavoriteOptions
} from "./favorites.js";

export {
  checkEntitlement,
  fetchLicensedKit,
  isOnlineOnly,
  OnlineOnlyContentRefusedError,
  type CheckEntitlementOptions,
  type EntitlementStatusResult,
  type FetchLicensedKitOptions,
  type FetchLicensedKitResult,
  type LicensedWatermark
} from "./licensed.js";

export {
  buildMultipartBody,
  fieldsRequireMultipart,
  planPackageUpload,
  sha256Hex,
  type PresignedUpload,
  type UploadPlan
} from "./upload.js";

export {
  buildForgeUploadRequest,
  submitKit,
  type ForgeUploadRequest,
  type ListingDraft,
  type SubmitKitOptions,
  type SubmitKitResult
} from "./submit.js";

export {
  assembleProvenance,
  downloadKit,
  normalizeMarketIdentifier,
  type DownloadKitOptions,
  type DownloadKitResult,
  type MarketProvenance
} from "./download.js";

export {
  extractAgentKitZip,
  importKit,
  type ImportKitOptions,
  type ImportKitResult
} from "./import.js";

export {
  checkKitUpdate,
  type CheckKitUpdateOptions,
  type KitUpdateStatus
} from "./update.js";
