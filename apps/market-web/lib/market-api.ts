export type TrustBadge = "Validated" | "Reviewed" | "Verified Publisher" | "Featured" | string;

export type ValidationStatus = "Validated" | "Pending" | "Failed" | "Unknown" | string;

export type ReviewStatus = "Reviewed" | "Pending Review" | "Rejected" | "Unknown" | string;

export type PublicPublisherProfile = {
  displayName: string | null;
  handle: string | null;
  avatarInitials: string | null;
  verified: boolean;
};

export type KitPublisher = {
  slug: string;
  name: string;
  initials: string;
  handle?: string;
  summary?: string;
  verified?: boolean;
};

export type PublisherSummary = KitPublisher;

export type RequiredInputSummary = {
  name: string;
  summary?: string;
  type?: string;
  required?: boolean;
};

export type PreparedPromptSummary = {
  name: string;
  summary?: string;
  purpose?: string;
};

export type SkillSummary = {
  name: string;
  summary?: string;
  capability?: string;
};

export type MarketKitListItem = {
  slug: string;
  name: string;
  summary: string;
  publisher: PublisherSummary;
  categories: string[];
  tags: string[];
  currentVersion?: string;
  trustBadges: TrustBadge[];
  validationStatus?: ValidationStatus;
  reviewStatus?: ReviewStatus;
  requiredInputs: RequiredInputSummary[];
  preparedPrompts: PreparedPromptSummary[];
  skills: SkillSummary[];
  updatedAt?: string;
  importCountLabel?: string;
  status?: string;
  // Tier-2 paid/licensed metadata (free-safe; all optional).
  kitId?: string;
  pricing?: "free" | "paid";
  priceModel?: "one_time" | "subscription";
  priceCents?: number;
  currency?: string;
  interval?: "month" | "year";
  /** Subscription free-trial days; only meaningful for subscription kits. */
  trialDays?: number;
  downloadable?: boolean;
  licenseType?: "default" | "custom";
  licenseVersion?: string;
};

export type MarketKitDetail = MarketKitListItem & {
  licenseText?: string;
  description?: string;
  outcomes?: string[];
  packageMetadata?: KitPackageMetadata;
  validationSummary?: PublicValidationSummary;
  versionMetadata?: Record<string, string | number | boolean | null>;
};

export type PublicValidationSummary = {
  status?: string;
  message?: string;
  checks: Array<{ name: string; status: string; summary?: string }>;
};

export type KitPackageMetadata = {
  fileName?: string;
  packageSizeBytes?: number;
  sha256?: string;
  publishedAt?: string;
};

export type KitDownloadResponse = {
  downloadUrl: string;
  expiresIn?: number;
  fileName?: string;
  kitId?: string;
  packageSizeBytes?: number;
  sha256?: string;
  slug?: string;
  version?: string;
};

export type MarketHealth = {
  ok: boolean;
  service?: string;
  version?: string;
};

export class MarketApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "MarketApiError";
    this.status = status;
  }
}

export class MarketConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketConfigError";
  }
}

type JsonObject = Record<string, unknown>;

const API_BASE_URL = process.env.NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL?.replace(/\/+$/, "");
const USE_MOCKS = process.env.NEXT_PUBLIC_AGENTKITMARKET_USE_MOCKS === "true";
const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

export function shouldUseMarketMocks() {
  return !IS_PRODUCTION && (USE_MOCKS || (!API_BASE_URL && IS_DEVELOPMENT));
}

export async function getHealth(): Promise<MarketHealth> {
  if (shouldUseMarketMocks()) {
    return { ok: true, service: "agentkitmarket-mock", version: "development" };
  }

  const payload = await requestJson("/health");

  if (!isObject(payload) || typeof payload.ok !== "boolean") {
    throw new MarketApiError("The marketplace health response was not in the expected format.");
  }

  return {
    ok: payload.ok,
    service: asOptionalString(payload.service),
    version: asOptionalString(payload.version)
  };
}

export async function listKits(): Promise<MarketKitListItem[]> {
  if (shouldUseMarketMocks()) {
    const { mockPublicKits } = await import("@/lib/catalog");
    return mockPublicKits;
  }

  const payload = await requestJson("/kits");

  if (!isObject(payload) || !Array.isArray(payload.items)) {
    throw new MarketApiError("The marketplace catalog response was not in the expected format.");
  }

  const kits = payload.items.map((item) => normalizeKitListItem(asObject(item)));
  logDevelopmentCatalogCount(kits.length);
  return kits;
}

export async function getKitBySlug(slug: string): Promise<MarketKitDetail | null> {
  if (shouldUseMarketMocks()) {
    const { getMockKit } = await import("@/lib/catalog");
    return getMockKit(slug) ?? null;
  }

  try {
    const payload = await requestJson(`/kits/${encodeURIComponent(slug)}`);
    return normalizeKitDetail(asObject(payload));
  } catch (error) {
    if (error instanceof MarketApiError && error.status === 404) {
      return null;
    }

    throw error;
  }
}

async function requestJson(path: string): Promise<unknown> {
  if (!API_BASE_URL) {
    throw new MarketConfigError(
      "AgentKitMarket API is not configured. Set NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL."
    );
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new MarketApiError(await responseErrorMessage(response), response.status);
  }

  return response.json();
}

async function responseErrorMessage(response: Response) {
  let message = `Marketplace API request failed with status ${response.status}.`;

  try {
    const payload = (await response.json()) as unknown;
    if (isObject(payload) && typeof payload.message === "string") {
      message = payload.message;
    }
  } catch {
    // Keep the status-based fallback when the response is not JSON.
  }

  return message;
}

function normalizeKitListItem(raw: JsonObject): MarketKitListItem {
  const slug = requiredString(raw.slug, "kit.slug");
  const publisher = normalizePublisher(raw.publisher, raw.publisherSlug, raw.publisherName);
  const requiredInputs = summaryArray(raw.requiredInputs ?? raw.requiredInputSummaries, "input");
  const preparedPrompts = summaryArray(raw.preparedPrompts ?? raw.preparedPromptSummaries, "prompt");
  const skills = summaryArray(raw.skills ?? raw.skillSummaries, "skill");
  const validationStatus = asOptionalString(raw.validationStatus) ?? inferStatus(raw, "validated", "Validated");
  const reviewStatus = asOptionalString(raw.reviewStatus) ?? inferStatus(raw, "reviewed", "Reviewed");
  const trustBadges = trustBadgesFrom(raw, publisher, validationStatus, reviewStatus);

  return {
    slug,
    name: requiredString(raw.name, "kit.name"),
    summary: asOptionalString(raw.summary) ?? asOptionalString(raw.description) ?? "No summary provided yet.",
    publisher,
    categories: stringArray(raw.categories),
    tags: stringArray(raw.tags),
    currentVersion: asOptionalString(raw.currentVersion ?? raw.version),
    trustBadges,
    validationStatus,
    reviewStatus,
    requiredInputs,
    preparedPrompts,
    skills,
    updatedAt: asOptionalString(raw.updatedAt ?? raw.lastUpdatedAt),
    importCountLabel: asOptionalString(raw.importCountLabel),
    status: asOptionalString(raw.status),
    ...normalizePricing(raw)
  };
}

function normalizePricing(raw: JsonObject): Partial<MarketKitListItem> {
  const pricingRaw = asOptionalString(raw.pricing);
  const pricing = pricingRaw === "paid" ? "paid" : pricingRaw === "free" ? "free" : undefined;
  const priceModelRaw = asOptionalString(raw.priceModel);
  const priceModel =
    priceModelRaw === "subscription" ? "subscription" : priceModelRaw === "one_time" ? "one_time" : undefined;
  const intervalRaw = asOptionalString(raw.interval);
  const interval = intervalRaw === "month" ? "month" : intervalRaw === "year" ? "year" : undefined;
  const licenseTypeRaw = asOptionalString(raw.licenseType);
  const licenseType = licenseTypeRaw === "custom" ? "custom" : licenseTypeRaw === "default" ? "default" : undefined;

  return {
    kitId: asOptionalString(raw.kitId ?? raw.id),
    pricing,
    priceModel,
    priceCents: asOptionalNumber(raw.priceCents),
    currency: asOptionalString(raw.currency),
    interval,
    trialDays: asOptionalNumber(raw.trialDays),
    downloadable: asOptionalBoolean(raw.downloadable),
    licenseType,
    licenseVersion: asOptionalString(raw.licenseVersion)
  };
}

export function isPublicCatalogKit(kit: Pick<MarketKitListItem, "status" | "validationStatus" | "reviewStatus">) {
  return (
    normalizedStatus(kit.status) === "published" &&
    normalizedStatus(kit.validationStatus) === "passed" &&
    normalizedStatus(kit.reviewStatus) === "approved"
  );
}

function logDevelopmentCatalogCount(count: number) {
  if (process.env.NODE_ENV === "development") {
    console.info("[agentkitmarket] public catalog kits returned from API", { count });
  }
}

export function normalizeKitDetail(raw: JsonObject): MarketKitDetail {
  const detailSource = detailSourceFrom(raw);
  const item = normalizeKitListItem(detailSource);

  return {
    ...item,
    description: asOptionalString(detailSource.description),
    outcomes: stringArray(detailSource.outcomes),
    packageMetadata: normalizePackageMetadata(detailSource),
    validationSummary: normalizePublicValidationSummary(detailSource.validationSummary ?? detailSource.validation),
    versionMetadata: normalizeVersionMetadata(detailSource.versionMetadata ?? detailSource.currentVersionMetadata),
    licenseText: asOptionalString(detailSource.licenseText)
  };
}

function detailSourceFrom(raw: JsonObject) {
  if (raw.item && isObject(raw.item)) {
    return raw.item;
  }

  if (raw.kit && isObject(raw.kit)) {
    return raw.kit;
  }

  return raw;
}

function normalizePublisher(rawPublisher: unknown, rawSlug: unknown, rawName: unknown): PublisherSummary {
  if (isObject(rawPublisher)) {
    const displayName = safePublicPublisherName(rawPublisher.displayName ?? rawPublisher.name, rawPublisher.handle);
    const safeHandle = safePublicHandle(rawPublisher.handle);
    const slug =
      asOptionalString(rawPublisher.slug) ??
      safeHandle ??
      asOptionalString(rawPublisher.publisherSlug) ??
      asOptionalString(rawSlug) ??
      asOptionalString(rawPublisher.publisherId) ??
      asOptionalString(rawPublisher.id) ??
      slugify(displayName);

    return {
      name: displayName,
      slug,
      initials: safeAvatarInitials(rawPublisher.avatarInitials) ?? publisherInitials(displayName, safeHandle),
      handle: safeHandle,
      summary: asOptionalString(rawPublisher.summary),
      verified: asOptionalBoolean(rawPublisher.verified)
    };
  }

  const name = safePublicPublisherName(rawName ?? rawPublisher);
  return {
    name,
    slug: asOptionalString(rawSlug) ?? slugify(name),
    initials: publisherInitials(name),
    verified: false
  };
}

function safePublicPublisherName(candidate: unknown, handle?: unknown) {
  const displayName = asOptionalString(candidate);
  if (displayName && !isSensitiveIdentityValue(displayName)) {
    return displayName;
  }

  const publicHandle = safePublicHandle(handle);
  if (publicHandle) {
    return publicHandle;
  }

  return "AgentKit user";
}

function safePublicHandle(value: unknown) {
  const handle = asOptionalString(value);
  return handle && !isSensitiveIdentityValue(handle) ? handle : undefined;
}

function safeAvatarInitials(value: unknown) {
  const initials = asOptionalString(value);
  return initials && /^[a-z0-9]{1,4}$/i.test(initials) ? initials.toUpperCase() : undefined;
}

function publisherInitials(displayName: string, handle?: unknown) {
  if (displayName === "AgentKit user") {
    return "AK";
  }

  const publicHandle = asOptionalString(handle);
  const source =
    displayName === "AgentKit user"
      ? publicHandle && !isSensitiveIdentityValue(publicHandle)
        ? publicHandle
        : displayName
      : displayName;
  const initials = source
    .replace(/^@/, "")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return initials || "AK";
}

function isSensitiveIdentityValue(value: string) {
  return /@/.test(value) || /^user(?:_|-)/i.test(value) || /^usr(?:_|-)/i.test(value) || /^workos(?:_|-)/i.test(value);
}

function summaryArray(value: unknown, fallbackPrefix: string) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, index) => {
    if (typeof entry === "string") {
      return [{ name: entry }];
    }

    if (!isObject(entry)) {
      return [];
    }

    const name =
      asOptionalString(entry.name) ??
      asOptionalString(entry.title) ??
      asOptionalString(entry.label) ??
      `${fallbackPrefix} ${index + 1}`;

    return [
      {
        name,
        summary: asOptionalString(entry.summary ?? entry.description),
        type: asOptionalString(entry.type),
        required: asOptionalBoolean(entry.required),
        purpose: asOptionalString(entry.purpose),
        capability: asOptionalString(entry.capability)
      }
    ];
  });
}

function trustBadgesFrom(
  raw: JsonObject,
  publisher: PublisherSummary,
  validationStatus?: string,
  reviewStatus?: string
): TrustBadge[] {
  const badges = new Set<string>(stringArray(raw.trustBadges ?? raw.badges ?? raw.trust));

  if (normalizedStatus(validationStatus) === "passed" || validationStatus === "Validated") {
    badges.add("Validated");
  }

  if (normalizedStatus(reviewStatus) === "approved" || reviewStatus === "Reviewed") {
    badges.add("Reviewed");
  }

  if (publisher.verified || raw.verifiedPublisher === true) {
    badges.add("Verified Publisher");
  }

  if (raw.featured === true) {
    badges.add("Featured");
  }

  return Array.from(badges);
}

function inferStatus(raw: JsonObject, key: string, status: string) {
  return raw[key] === true ? status : undefined;
}

function normalizedStatus(value?: string) {
  return value?.trim().toLowerCase();
}

function normalizeVersionMetadata(value: unknown) {
  if (!isObject(value)) {
    return undefined;
  }

  const safeEntries = Object.entries(value).filter((entry): entry is [string, string | number | boolean | null] => {
      if (isSensitivePublicMetadataKey(entry[0])) {
        return false;
      }

      const candidate = entry[1];
      return candidate === null || ["string", "number", "boolean"].includes(typeof candidate);
    });

  return safeEntries.length > 0 ? Object.fromEntries(safeEntries) : undefined;
}

function normalizePackageMetadata(detailSource: JsonObject): KitPackageMetadata | undefined {
  const latestVersion = isObject(detailSource.latestVersion) ? detailSource.latestVersion : {};
  const packageMetadata = isObject(detailSource.packageMetadata)
    ? detailSource.packageMetadata
    : isObject(detailSource.package)
      ? detailSource.package
      : {};
  const versionMetadata = isObject(detailSource.versionMetadata)
    ? detailSource.versionMetadata
    : isObject(detailSource.currentVersionMetadata)
      ? detailSource.currentVersionMetadata
      : {};
  const metadata: KitPackageMetadata = {
    fileName: asOptionalString(
      detailSource.fileName ?? latestVersion.fileName ?? packageMetadata.fileName ?? versionMetadata.fileName
    ),
    packageSizeBytes: asOptionalNumber(
      detailSource.packageSizeBytes ??
        detailSource.sizeBytes ??
        latestVersion.packageSizeBytes ??
        latestVersion.sizeBytes ??
        packageMetadata.packageSizeBytes ??
        packageMetadata.sizeBytes ??
        versionMetadata.packageSizeBytes ??
        versionMetadata.sizeBytes
    ),
    sha256: asOptionalString(
      detailSource.sha256 ??
        detailSource.sha256Checksum ??
        latestVersion.sha256 ??
        latestVersion.sha256Checksum ??
        packageMetadata.sha256 ??
        packageMetadata.sha256Checksum ??
        versionMetadata.sha256 ??
        versionMetadata.sha256Checksum
    ),
    publishedAt: asOptionalString(
      detailSource.publishedAt ??
        latestVersion.publishedAt ??
        packageMetadata.publishedAt ??
        versionMetadata.publishedAt
    )
  };

  return Object.values(metadata).some((value) => value !== undefined) ? metadata : undefined;
}

function normalizePublicValidationSummary(value: unknown): PublicValidationSummary | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const checks = Array.isArray(value.checks)
    ? value.checks.flatMap((check) => {
        if (!isObject(check)) {
          return [];
        }

        return [
          {
            name: asOptionalString(check.name) ?? "Validation check",
            status: asOptionalString(check.status) ?? "unknown",
            summary: asOptionalString(check.summary ?? check.message)
          }
        ];
      })
    : [];
  const summary: PublicValidationSummary = {
    status: asOptionalString(value.status),
    message: asOptionalString(value.message ?? value.summary),
    checks
  };

  return summary.status || summary.message || summary.checks.length > 0 ? summary : undefined;
}

function isSensitivePublicMetadataKey(key: string) {
  return /s3|bucket|key|log|file|tree|package/i.test(key);
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new MarketApiError(`The marketplace response is missing ${label}.`);
  }

  return value;
}

function asOptionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function asObject(value: unknown): JsonObject {
  if (!isObject(value)) {
    throw new MarketApiError("The marketplace response was not a JSON object.");
  }

  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
