"use client";

import type { ComponentType } from "react";
import dynamic from "next/dynamic";

/**
 * Gated loader for the commercial paid-kit acquire button. The real component
 * (`KitAcquireButton`) lives in the optional @agentkit-commercial/market-web
 * package. It is loaded via next/dynamic ONLY when NEXT_PUBLIC_COMMERCE_ENABLED
 * is set, so the public/free bundle never resolves the moved component. When
 * commerce is off, this renders a clear "available in the hosted marketplace"
 * notice instead of the buy flow.
 */

type AcquireProps = {
  slug: string;
  priceText: string;
  pricing: "paid";
  priceModel?: "one_time" | "subscription";
  trialDays?: number;
  downloadable: boolean;
  licenseText: string;
  licenseVersion?: string;
  isAdmin: boolean;
  /** Canonical Market kit id (passed into the run deep links). */
  marketKitId?: string;
  /** Public AgentKitAuto base URL for the protected-kit "Run on Auto" action
   *  (autonomous run). Undefined → the action hides (self-host with no Auto). */
  autoUrl?: string;
  /** Public web-Forge base URL for the protected-kit "Use in Forge (web)" action
   *  (interactive use). Undefined → the action hides (self-host with no Forge). */
  forgeWebUrl?: string;
};

const commerceEnabled = process.env.NEXT_PUBLIC_COMMERCE_ENABLED === "1";

// The specifier is held in a variable so webpack does NOT statically resolve the
// optional package at build time (the public/free build never installs it). The
// import only runs when commerce is enabled AND the package is present.
const COMMERCIAL_MODULE = "@agentkit-commercial/market-web";

const KitAcquireButton = commerceEnabled
  ? dynamic<AcquireProps>(
      () =>
        import(/* webpackIgnore: true */ COMMERCIAL_MODULE).then(
          (m: { KitAcquireButton: ComponentType<AcquireProps> }) => m.KitAcquireButton
        ),
      { ssr: false }
    )
  : null;

export function CommercialAcquire(props: AcquireProps) {
  if (!KitAcquireButton) {
    return (
      <div className="rule-callout">
        <strong>Available in the hosted marketplace</strong>
        <span>Paid kits can be purchased on the hosted AgentKitMarket.</span>
      </div>
    );
  }
  return <KitAcquireButton {...props} />;
}
