/**
 * M6 Slice 2 — web-Forge deep-link / protected-kit selection parsing.
 *
 * Pure helpers (no DOM/React): the `?kit=market:<slug>` deep link Market's "Use
 * in Forge (web)" button produces, and the entitlement-checked resolution that
 * refuses a stale link for an un-owned slug (defense-in-depth — the run is also
 * entitlement-gated server-side).
 */

import { describe, expect, it } from "vitest";
import {
  isMarketSelection,
  marketSelectionValue,
  parseMarketDeepLink,
  resolveMarketSelection,
  type EntitledKit
} from "@/app/forge/sections/market-kit-ref";

const ENTITLED: EntitledKit[] = [
  { marketKitId: "mk-1", slug: "secret-rubric", name: "Secret Rubric" },
  { marketKitId: "mk-2", slug: "pro-pack", name: "Pro Pack" }
];

describe("parseMarketDeepLink", () => {
  it("extracts the slug from a market: deep link", () => {
    expect(parseMarketDeepLink("market:secret-rubric")).toBe("secret-rubric");
  });

  it("trims surrounding whitespace", () => {
    expect(parseMarketDeepLink("market:  pro-pack  ")).toBe("pro-pack");
  });

  it("ignores non-market params, nulls, and empty slugs", () => {
    expect(parseMarketDeepLink(null)).toBeNull();
    expect(parseMarketDeepLink(undefined)).toBeNull();
    expect(parseMarketDeepLink("local-kit-id")).toBeNull();
    expect(parseMarketDeepLink("market:")).toBeNull();
    expect(parseMarketDeepLink("market:   ")).toBeNull();
  });
});

describe("marketSelectionValue / isMarketSelection", () => {
  it("round-trips a slug into a market: selector value", () => {
    const value = marketSelectionValue("secret-rubric");
    expect(value).toBe("market:secret-rubric");
    expect(isMarketSelection(value)).toBe(true);
  });

  it("treats a raw local kit id as NOT a market selection", () => {
    expect(isMarketSelection("kit_abc123")).toBe(false);
  });
});

describe("resolveMarketSelection", () => {
  it("resolves a market: value to a ref ONLY for an entitled slug", () => {
    expect(resolveMarketSelection("market:secret-rubric", ENTITLED)).toEqual({
      marketKitId: "mk-1",
      slug: "secret-rubric"
    });
  });

  it("refuses a stale/un-owned slug (returns null) so a deep link can't fake entitlement", () => {
    expect(resolveMarketSelection("market:not-owned", ENTITLED)).toBeNull();
    expect(resolveMarketSelection("market:secret-rubric", [])).toBeNull();
  });

  it("returns null for a non-market value (local kit id)", () => {
    expect(resolveMarketSelection("kit_abc123", ENTITLED)).toBeNull();
  });
});
