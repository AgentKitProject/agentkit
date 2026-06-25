/**
 * App-side mirror of the platform default Agent Kit EULA.
 *
 * The canonical text + version constant lives in `@agentkitforge/market-core`
 * (embedded in the watermarked package + backend), but market-core must never
 * be imported into the browser app. The version id is re-exported from
 * `@agentkitforge/contracts` (`DEFAULT_KIT_LICENSE_VERSION` === "default-v1");
 * we keep the human-readable text here so the acceptance modal can render the
 * effective license for default-licensed kits without a backend round-trip.
 *
 * Keep this text in sync with the `default-v1` text core embeds.
 */
import { DEFAULT_KIT_LICENSE_VERSION } from "@agentkitforge/contracts";

export { DEFAULT_KIT_LICENSE_VERSION };

export const DEFAULT_KIT_LICENSE_TEXT = `AgentKitProject Standard Kit License (default-v1)

1. Grant. Subject to your acceptance of these terms and, for paid kits, your
   completed acquisition, the publisher grants you a non-exclusive,
   non-transferable license to use this Agent Kit and its contents (the
   "Kit") for your own and your organization's internal purposes.

2. Restrictions. You may not resell, sublicense, publicly redistribute, or
   republish the Kit or its contents as a standalone product. You may not
   remove or alter any provenance, attribution, or watermark embedded in the
   Kit package.

3. Online-only kits. Some paid kits are made available for in-product
   (AgentKitForge) use only and are not provided as a downloadable package.
   Your license does not entitle you to a downloadable copy of such kits.

4. Ownership. The publisher (or its licensors) retains all right, title, and
   interest in and to the Kit. No rights are granted except as expressly set
   out here.

5. No warranty. The Kit is provided "as is" without warranty of any kind.
   AgentKitProject and the publisher are not liable for any damages arising
   from your use of the Kit, to the maximum extent permitted by law.

6. Termination. This license terminates automatically if you breach these
   terms. Upon termination you must stop using and delete any local copies of
   the Kit.

By accepting, you confirm that you have read and agree to this license.`;

/**
 * Resolve the effective license text for a kit:
 *   - custom license  -> the publisher-provided text (falls back to default if absent)
 *   - default license -> the platform default EULA above
 */
export function effectiveLicenseText(input: {
  licenseType?: "default" | "custom";
  licenseText?: string;
}): string {
  if (input.licenseType === "custom" && input.licenseText && input.licenseText.trim().length > 0) {
    return input.licenseText;
  }
  return DEFAULT_KIT_LICENSE_TEXT;
}

/** Resolve the effective license version id for a kit. */
export function effectiveLicenseVersion(input: {
  licenseType?: "default" | "custom";
  licenseVersion?: string;
}): string {
  if (input.licenseType === "custom" && input.licenseVersion && input.licenseVersion.trim().length > 0) {
    return input.licenseVersion;
  }
  return DEFAULT_KIT_LICENSE_VERSION;
}

/** Format a price in cents to a "$X.XX" string. */
export function formatPriceCents(priceCents?: number, currency: string = "USD"): string {
  const cents = typeof priceCents === "number" && Number.isFinite(priceCents) ? priceCents : 0;
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

/** Short suffix for subscription pricing, e.g. "/mo" or "/yr". */
export function intervalSuffix(interval?: "month" | "year"): string {
  if (interval === "month") {
    return "/mo";
  }
  if (interval === "year") {
    return "/yr";
  }
  return "";
}

/** Full human price label, e.g. "Free", "$9.99", "$5.00/mo". */
export function priceLabel(input: {
  pricing?: "free" | "paid";
  priceModel?: "one_time" | "subscription";
  priceCents?: number;
  currency?: string;
  interval?: "month" | "year";
}): string {
  if (input.pricing !== "paid") {
    return "Free";
  }
  const base = formatPriceCents(input.priceCents, input.currency ?? "USD");
  if (input.priceModel === "subscription") {
    return `${base}${intervalSuffix(input.interval)}`;
  }
  return base;
}
