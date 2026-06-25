import { describe, expect, test } from "vitest";
import {
  aiProviderTypes,
  getDefaultModelForProvider,
  getKnownModelsForProvider,
  getProviderCapabilities,
  isApiKeyRequiredForProvider,
  isBaseUrlRequiredForProvider,
  normalizeBaseUrl,
  providerSupportsStructuredJson,
  structuredOutputGuidance
} from "../src/providers/catalog.js";

describe("AI provider metadata", () => {
  test("provider type catalog contains all required providers", () => {
    expect(aiProviderTypes).toEqual([
      "openai",
      "anthropic",
      "gemini",
      "ollama",
      "openai-compatible"
    ]);
  });

  test("known model lookup works", () => {
    expect(getKnownModelsForProvider("openai").length).toBeGreaterThan(0);
    expect(getKnownModelsForProvider("openai").every((model) => model.providerTypes.includes("openai"))).toBe(true);
    expect(getKnownModelsForProvider("ollama").some((model) => model.recommendedFor.includes("local"))).toBe(true);
  });

  test("default model lookup works", () => {
    expect(getDefaultModelForProvider("openai")).toBe(getKnownModelsForProvider("openai")[0]?.id);
    expect(getDefaultModelForProvider("openai-compatible")).toBeUndefined();
  });

  test("api key required helper works", () => {
    expect(isApiKeyRequiredForProvider("openai")).toBe(true);
    expect(isApiKeyRequiredForProvider("anthropic")).toBe(true);
    expect(isApiKeyRequiredForProvider("gemini")).toBe(true);
    expect(isApiKeyRequiredForProvider("ollama")).toBe(false);
    expect(isApiKeyRequiredForProvider("openai-compatible")).toBe(true);
  });

  test("base URL required helper works", () => {
    expect(isBaseUrlRequiredForProvider("openai")).toBe(false);
    expect(isBaseUrlRequiredForProvider("ollama")).toBe(true);
    expect(isBaseUrlRequiredForProvider("openai-compatible")).toBe(true);
    expect(normalizeBaseUrl("ollama")).toBe("http://localhost:11434");
    expect(normalizeBaseUrl("openai-compatible", "https://models.example.test/v1/")).toBe(
      "https://models.example.test/v1"
    );
  });

  test("custom/openai-compatible does not force known models", () => {
    expect(getKnownModelsForProvider("openai-compatible")).toEqual([]);
    expect(getProviderCapabilities("openai-compatible").supportsCustomModels).toBe(true);
  });

  test("structured JSON support helper respects explicit override", () => {
    expect(providerSupportsStructuredJson("ollama", "llama3.1")).toBe(false);
    expect(providerSupportsStructuredJson("ollama", "llama3.1", true)).toBe(true);
    expect(providerSupportsStructuredJson("openai", getDefaultModelForProvider("openai"))).toBe(true);
    expect(providerSupportsStructuredJson("openai-compatible", "custom-json-model", false)).toBe(false);
  });

  test("structured output guidance describes draft JSON requirements", () => {
    expect(structuredOutputGuidance.draftGeneration).toContain("AgentKitDraft");
    expect(structuredOutputGuidance.localModelWarning).toContain("Local");
  });
});
