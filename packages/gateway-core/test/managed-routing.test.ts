/**
 * Unit tests for the model-aware managed routing provider.
 *
 * Verifies (a) the model→provider classifier, (b) that the wrapper delegates a
 * Claude request to the Anthropic key and a GPT request to the OpenAI key, and
 * (c) that a Claude-only deployment (no OPENAI_API_KEY) is UNAFFECTED — the
 * OpenAI provider is only constructed when a gpt-* request actually arrives.
 * No network I/O: we assert on which underlying factory throws (inert-key path).
 */

import { describe, it, expect } from "vitest";
import {
  createManagedRoutingProvider,
  classifyManagedModelProvider,
} from "../src/index.js";
import { getModelPricing } from "../src/core/pricing.js";

const req = (model: string) => ({
  model,
  system: "",
  messages: [],
  tools: [],
  maxTokens: 16,
});

describe("classifyManagedModelProvider", () => {
  it("routes gpt-* / chatgpt / o-series to openai", () => {
    for (const m of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "GPT-5.4-NANO", "chatgpt-4o", "o3-mini", "o1"]) {
      expect(classifyManagedModelProvider(m)).toBe("openai");
    }
  });
  it("routes claude and anything unknown to anthropic (default)", () => {
    for (const m of ["claude-sonnet-4-6", "claude-haiku-4-5", "something-else", ""]) {
      expect(classifyManagedModelProvider(m)).toBe("anthropic");
    }
  });
});

describe("createManagedRoutingProvider", () => {
  it("uses the Anthropic key for a claude model", async () => {
    const provider = createManagedRoutingProvider({
      env: { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "sk-openai" },
    });
    // Anthropic key is blank → the anthropic factory throws its inert error,
    // proving the claude request routed to the anthropic provider.
    await expect(provider.sendMessage(req("claude-sonnet-4-6"))).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("uses the OpenAI key for a gpt model", async () => {
    const provider = createManagedRoutingProvider({
      env: { ANTHROPIC_API_KEY: "sk-anthropic", OPENAI_API_KEY: "" },
    });
    await expect(provider.sendMessage(req("gpt-5.4"))).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("a Claude-only deployment (no OPENAI_API_KEY) is unaffected for claude runs", () => {
    // Constructing the router with only ANTHROPIC_API_KEY must NOT throw — the
    // OpenAI provider is lazy and never built unless a gpt-* request arrives.
    expect(() =>
      createManagedRoutingProvider({ env: { ANTHROPIC_API_KEY: "sk-anthropic" } }),
    ).not.toThrow();
  });
});

describe("gateway pricing: managed GPT models", () => {
  it("prices the GPT ladder as known models (at-cost input/output)", () => {
    const expected: Record<string, [number, number]> = {
      "gpt-5.4-nano": [0.2, 1.25],
      "gpt-5.4-mini": [0.75, 4.5],
      "gpt-5.4": [2.5, 15.0],
      "gpt-5.5": [5.0, 30.0],
    };
    for (const [id, [input, output]] of Object.entries(expected)) {
      const p = getModelPricing(id);
      expect(p.knownModel).toBe(true);
      expect(p.inputPerMillion).toBe(input);
      expect(p.outputPerMillion).toBe(output);
    }
  });
});
