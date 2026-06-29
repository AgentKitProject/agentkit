/**
 * Unit tests for the pure pricing / metering service.
 * No I/O, no infrastructure required.
 */

import { describe, it, expect } from "vitest";
import {
  computeDebitCents,
  computeMaxHoldCents,
  getModelPricing,
} from "../src/core/pricing.js";

const NO_MARKUP = 0;         // 0 bps = no markup
// Illustrative, clearly non-production example markup used only in these tests.
const MARKUP_20 = 2000;      // 2000 bps = 20% (example rate, not a real config value)

describe("getModelPricing", () => {
  it("returns known pricing for claude-sonnet-4-6", () => {
    const pricing = getModelPricing("claude-sonnet-4-6");
    expect(pricing.inputPerMillion).toBe(3.0);
    expect(pricing.outputPerMillion).toBe(15.0);
    expect(pricing.knownModel).toBe(true);
  });

  it("returns known pricing for claude-haiku-4-5", () => {
    const pricing = getModelPricing("claude-haiku-4-5");
    expect(pricing.inputPerMillion).toBe(1.0);
    expect(pricing.outputPerMillion).toBe(5.0);
    expect(pricing.knownModel).toBe(true);
  });

  it("returns known pricing for claude-opus-4-8", () => {
    const pricing = getModelPricing("claude-opus-4-8");
    expect(pricing.inputPerMillion).toBe(5.0);
    expect(pricing.outputPerMillion).toBe(25.0);
    expect(pricing.knownModel).toBe(true);
  });

  it("returns known pricing for claude-fable-5", () => {
    const pricing = getModelPricing("claude-fable-5");
    expect(pricing.inputPerMillion).toBe(10.0);
    expect(pricing.outputPerMillion).toBe(50.0);
    expect(pricing.knownModel).toBe(true);
  });

  it("strips date suffix before lookup (e.g. claude-sonnet-4-6-20261015)", () => {
    const pricing = getModelPricing("claude-sonnet-4-6-20261015");
    expect(pricing.knownModel).toBe(true);
    expect(pricing.inputPerMillion).toBe(3.0);
  });

  it("falls back to _unknown for an unknown model (conservative Sonnet rate)", () => {
    const pricing = getModelPricing("gpt-99-turbo");
    expect(pricing.knownModel).toBe(false);
    // _unknown falls back to Sonnet rates
    expect(pricing.inputPerMillion).toBe(3.0);
    expect(pricing.outputPerMillion).toBe(15.0);
  });
});

describe("computeDebitCents — zero usage", () => {
  it("returns 0 for all-zero usage", () => {
    expect(
      computeDebitCents(
        { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
        "claude-sonnet-4-6",
        MARKUP_20,
      ),
    ).toBe(0);
  });
});

describe("computeDebitCents — no markup", () => {
  it("computes input-only cost correctly (Sonnet $3/1M)", () => {
    // 1,000,000 input tokens at $3/1M = $3.00 = 300 cents
    const cents = computeDebitCents(
      { inputTokens: 1_000_000, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
      "claude-sonnet-4-6",
      NO_MARKUP,
    );
    expect(cents).toBe(300);
  });

  it("computes output-only cost correctly (Sonnet $15/1M)", () => {
    // 100,000 output tokens at $15/1M = $1.50 = 150 cents
    const cents = computeDebitCents(
      { inputTokens: 0, outputTokens: 100_000, cachedReadTokens: 0, cachedWriteTokens: 0 },
      "claude-sonnet-4-6",
      NO_MARKUP,
    );
    expect(cents).toBe(150);
  });

  it("computes cached-read tokens at 10% of input rate", () => {
    // 1,000,000 cached-read tokens at $3*0.1/1M = $0.30/1M = 30 cents USD-raw.
    // Floating point: 3.0 * 0.1 = 0.30000000000000004 → 30.000000000000004 cents raw
    // → Math.ceil → 31 cents. This is the correct behaviour (never under-charge).
    const cents = computeDebitCents(
      { inputTokens: 1_000_000, outputTokens: 0, cachedReadTokens: 1_000_000, cachedWriteTokens: 0 },
      "claude-sonnet-4-6",
      NO_MARKUP,
    );
    // non-cached input = max(0, 1M - 1M - 0) = 0
    // cached-read 1M at $0.3/1M → 30.000...004 raw cents → ceil → 31
    expect(cents).toBe(31);
  });

  it("computes cached-write tokens at 125% of input rate", () => {
    // 1,000,000 cache-write tokens at $3*1.25/1M = $3.75 = 375 cents
    const cents = computeDebitCents(
      { inputTokens: 1_000_000, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 1_000_000 },
      "claude-sonnet-4-6",
      NO_MARKUP,
    );
    // non-cached input = 0 (all are write tokens); write 1M at $3.75/1M = 375 cents
    expect(cents).toBe(375);
  });

  it("combines all token types correctly", () => {
    // 100K non-cached input + 100K cached-read + 100K cached-write + 50K output
    // = (100K * $3 + 100K * $0.30 + 100K * $3.75 + 50K * $15) / 1M
    // = (300 + 30 + 375 + 750) / 1M USD * cents-conversion
    // = $1455 / 1000 = $1.455 = ceil(145.5) = 146 cents
    const cents = computeDebitCents(
      {
        inputTokens: 300_000,   // 100K non-cached + 100K read + 100K write = 300K
        outputTokens: 50_000,
        cachedReadTokens: 100_000,
        cachedWriteTokens: 100_000,
      },
      "claude-sonnet-4-6",
      NO_MARKUP,
    );
    expect(cents).toBe(146);
  });
});

describe("computeDebitCents — with a 20% example markup", () => {
  it("applies a 20% example markup and rounds up", () => {
    // 1,000 input tokens at Sonnet $3/1M = $0.003
    // with 20% markup = $0.0036 = 0.36 cents → ceil → 1 cent (minimum)
    const cents = computeDebitCents(
      { inputTokens: 1_000, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
      "claude-sonnet-4-6",
      MARKUP_20,
    );
    expect(cents).toBeGreaterThanOrEqual(1);
  });

  it("applies a 20% example markup on a larger call", () => {
    // 1,000,000 input + 100,000 output at Sonnet
    // = ($3.00 + $1.50) = $4.50 raw
    // * 1.20 = $5.40 = ceil(540) = 540 cents
    const cents = computeDebitCents(
      { inputTokens: 1_000_000, outputTokens: 100_000, cachedReadTokens: 0, cachedWriteTokens: 0 },
      "claude-sonnet-4-6",
      MARKUP_20,
    );
    expect(cents).toBe(540);
  });

  it("a 20% example markup on Opus is higher than Sonnet", () => {
    const sonnet = computeDebitCents(
      { inputTokens: 100_000, outputTokens: 10_000, cachedReadTokens: 0, cachedWriteTokens: 0 },
      "claude-sonnet-4-6",
      MARKUP_20,
    );
    const opus = computeDebitCents(
      { inputTokens: 100_000, outputTokens: 10_000, cachedReadTokens: 0, cachedWriteTokens: 0 },
      "claude-opus-4-8",
      MARKUP_20,
    );
    expect(opus).toBeGreaterThan(sonnet);
  });
});

describe("computeDebitCents — minimum 1 cent", () => {
  it("returns at least 1 cent for any non-zero usage", () => {
    // 1 output token should cost something > 0
    const cents = computeDebitCents(
      { inputTokens: 0, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0 },
      "claude-haiku-4-5",
      NO_MARKUP,
    );
    expect(cents).toBeGreaterThanOrEqual(1);
  });
});

describe("computeMaxHoldCents", () => {
  it("is always >= the actual debit for the same token counts", () => {
    // The hold is computed assuming no caching (worst case).
    const hold = computeMaxHoldCents(50_000, 2_000, "claude-sonnet-4-6", MARKUP_20);
    const actual = computeDebitCents(
      { inputTokens: 50_000, outputTokens: 2_000, cachedReadTokens: 0, cachedWriteTokens: 0 },
      "claude-sonnet-4-6",
      MARKUP_20,
    );
    expect(hold).toBe(actual);
  });

  it("hold with cached input is larger than actual with cache savings", () => {
    const hold = computeMaxHoldCents(50_000, 2_000, "claude-sonnet-4-6", MARKUP_20);
    // Actual: 30K cached-read (cheap) + 20K non-cached + 2K output
    const actual = computeDebitCents(
      {
        inputTokens: 50_000,
        outputTokens: 2_000,
        cachedReadTokens: 30_000,
        cachedWriteTokens: 0,
      },
      "claude-sonnet-4-6",
      MARKUP_20,
    );
    // Hold (no caching assumed) should be >= actual (with cache savings).
    expect(hold).toBeGreaterThanOrEqual(actual);
  });
});
