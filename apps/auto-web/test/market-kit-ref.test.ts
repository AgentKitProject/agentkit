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
  type EntitledKit
} from "@/app/sections/market-kit-ref";

const ENTITLED: EntitledKit[] = [
  { marketKitId: "mk-1", slug: "secret-rubric", name: "Secret Rubric" },
  { marketKitId: "mk-2", slug: "pro-pack", name: "Pro Pack" }
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
