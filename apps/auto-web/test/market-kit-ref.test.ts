/**
 * M6 Slice 3 — deep-link + kit-selection parsing for the Auto "run on Auto"
 * buyer entry point. These are the pure helpers behind AutoSection's selector
 * values and the `?kit=market:<slug>` deep link from the Market commercial UI.
 */

import { describe, expect, it } from "vitest";
import {
  MARKET_PREFIX,
  isMarketSelection,
  marketSelectionValue,
  parseKitSelection,
  parseMarketDeepLink,
  creditsDisclosureKind,
  selectionRoyaltyCents,
  receiptRoyaltyCents,
  type EntitledKit
} from "@/app/sections/market-kit-ref";

const ENTITLED: EntitledKit[] = [
  { marketKitId: "mk-1", slug: "secret-rubric", name: "Secret Rubric", perRunRoyaltyCents: 30 },
  { marketKitId: "mk-2", slug: "pro-pack", name: "Pro Pack" } // non-premium (no per-run price)
];

describe("market selection values", () => {
  it("round-trips a slug through the market: prefix", () => {
    expect(marketSelectionValue("secret-rubric")).toBe("market:secret-rubric");
    expect(MARKET_PREFIX).toBe("market:");
    expect(isMarketSelection("market:secret-rubric")).toBe(true);
    expect(isMarketSelection("local-kit-id")).toBe(false);
  });
});

describe("parseKitSelection", () => {
  it("resolves a local kit id to a local KitRef", () => {
    expect(parseKitSelection("kit-abc", ENTITLED)).toEqual({ source: "local", localKitId: "kit-abc" });
  });

  it("resolves an ENTITLED market slug to a market KitRef (marketKitId + slug)", () => {
    expect(parseKitSelection("market:secret-rubric", ENTITLED)).toEqual({
      source: "market",
      marketKitId: "mk-1",
      slug: "secret-rubric"
    });
  });

  it("refuses a market slug the user does NOT own (no faked entitlement via deep link)", () => {
    expect(parseKitSelection("market:not-owned", ENTITLED)).toBeNull();
  });

  it("returns null for an empty value", () => {
    expect(parseKitSelection("", ENTITLED)).toBeNull();
  });
});

describe("parseMarketDeepLink", () => {
  it("extracts the slug from a market: deep link", () => {
    expect(parseMarketDeepLink("market:secret-rubric")).toBe("secret-rubric");
  });

  it("trims surrounding whitespace", () => {
    expect(parseMarketDeepLink("market:  pro-pack  ")).toBe("pro-pack");
  });

  it("ignores non-market params and empties", () => {
    expect(parseMarketDeepLink(null)).toBeNull();
    expect(parseMarketDeepLink(undefined)).toBeNull();
    expect(parseMarketDeepLink("local-kit")).toBeNull();
    expect(parseMarketDeepLink("market:")).toBeNull();
    expect(parseMarketDeepLink("market:   ")).toBeNull();
  });
});

describe("selectionRoyaltyCents — the premium per-run price of the selected kit (M6 P4)", () => {
  it("returns the per-run price for a selected PREMIUM entitled kit", () => {
    expect(selectionRoyaltyCents("market:secret-rubric", ENTITLED)).toBe(30);
  });

  it("returns 0 for a non-premium protected kit (no per-run price)", () => {
    expect(selectionRoyaltyCents("market:pro-pack", ENTITLED)).toBe(0);
  });

  it("returns 0 for a local kit and for a slug the user does not own", () => {
    expect(selectionRoyaltyCents("kit-abc", ENTITLED)).toBe(0);
    expect(selectionRoyaltyCents("market:not-owned", ENTITLED)).toBe(0);
    expect(selectionRoyaltyCents("", ENTITLED)).toBe(0);
  });
});

describe("receiptRoyaltyCents — itemizing the per-run price on a run receipt (M6 P4)", () => {
  it("derives the royalty as total − inference − compute", () => {
    // spentCents 335 = inference 5 + compute 30 + royalty 300.
    expect(
      receiptRoyaltyCents({ spentCents: 335, spentInferenceCents: 5, spentComputeCents: 30 })
    ).toBe(300);
  });

  it("is 0 for a non-premium run (total == inference + compute)", () => {
    expect(
      receiptRoyaltyCents({ spentCents: 35, spentInferenceCents: 5, spentComputeCents: 30 })
    ).toBe(0);
  });

  it("reads 0 on an older record with no split (both undefined)", () => {
    expect(receiptRoyaltyCents({ spentCents: 100 })).toBe(0);
  });

  it("treats a missing single split field as 0 and clamps ≥ 0", () => {
    // compute present, inference absent → royalty = 50 − 0 − 20 = 30.
    expect(receiptRoyaltyCents({ spentCents: 50, spentComputeCents: 20 })).toBe(30);
    // never negative.
    expect(receiptRoyaltyCents({ spentCents: 10, spentComputeCents: 20 })).toBe(0);
  });
});

describe("creditsDisclosureKind — the 'costs Auto credits' gating", () => {
  it("shows the FULL disclosure for a protected kit on a METERED deployment", () => {
    expect(creditsDisclosureKind("market:secret-rubric", true)).toBe("full");
  });

  it("shows a BRIEF (output-only) note for a protected kit on an UNMETERED deployment", () => {
    expect(creditsDisclosureKind("market:secret-rubric", false)).toBe("brief");
  });

  it("shows NO protected disclosure for a local/free kit (regardless of metering)", () => {
    expect(creditsDisclosureKind("local-kit-id", true)).toBe("none");
    expect(creditsDisclosureKind("local-kit-id", false)).toBe("none");
  });
});
