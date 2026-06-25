"use client";

import type { ComponentType } from "react";
import dynamic from "next/dynamic";

/**
 * Gated loader for the commercial Stripe Connect seller-payouts panel. The real
 * component (`OrgPayoutsPanel`) lives in the optional
 * @agentkit-commercial/market-web package and is loaded via next/dynamic ONLY
 * when NEXT_PUBLIC_COMMERCE_ENABLED=1, so the public/free bundle never resolves
 * the moved component. When commerce is off this renders nothing.
 */

type PayoutsProps = { orgId: string };

const commerceEnabled = process.env.NEXT_PUBLIC_COMMERCE_ENABLED === "1";

// Specifier held in a variable so webpack does not statically resolve the
// optional package at build time (the public/free build never installs it).
const COMMERCIAL_MODULE = "@agentkit-commercial/market-web";

const OrgPayoutsPanel = commerceEnabled
  ? dynamic<PayoutsProps>(
      () =>
        import(/* webpackIgnore: true */ COMMERCIAL_MODULE).then(
          (m: { OrgPayoutsPanel: ComponentType<PayoutsProps> }) => m.OrgPayoutsPanel
        ),
      { ssr: false }
    )
  : null;

export function CommercialPayouts(props: PayoutsProps) {
  if (!OrgPayoutsPanel) {
    return null;
  }
  return <OrgPayoutsPanel {...props} />;
}
