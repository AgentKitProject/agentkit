// buildChatProvider — construct a ChatProvider for any supported provider type.
//
// One place that maps (providerType, apiKey, baseUrl, model) → the right adapter,
// so callers (AgentKitAuto's BYO composition, Web-Forge, tests) don't switch on
// the provider themselves. Every adapter conforms to the same ChatProvider
// interface, so the agentic run loop is unchanged regardless of provider.
import type { ChatProvider } from "../core/ports.js";
import type { AiProviderType } from "../core/types.js";
import { AnthropicChatProvider } from "./anthropic/index.js";
import { OpenAIChatProvider, OpenAICompatibleChatProvider } from "./openai/index.js";
import { OllamaChatProvider } from "./ollama/index.js";
import { GeminiChatProvider } from "./gemini/index.js";

export interface BuildChatProviderOptions {
  providerType: AiProviderType;
  /** Required for anthropic/openai/openai-compatible/gemini; optional for ollama (local). */
  apiKey?: string;
  /** Required for openai-compatible; optional elsewhere (each adapter has a default). */
  baseUrl?: string;
  /** Fallback model when a request omits one (ignored by the Anthropic adapter). */
  model?: string;
}

/**
 * Build a ChatProvider for the given provider type. Throws on an unsupported
 * type, a missing required api key, or a missing base URL for openai-compatible.
 */
export function buildChatProvider(opts: BuildChatProviderOptions): ChatProvider {
  const { providerType, apiKey, baseUrl, model } = opts;

  const requireKey = (): string => {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error(`A ${providerType} API key is required.`);
    }
    return apiKey;
  };

  switch (providerType) {
    case "anthropic":
      // The Anthropic adapter takes the model per-request, not in its constructor.
      return new AnthropicChatProvider({
        apiKey: requireKey(),
        ...(baseUrl ? { baseUrl } : {})
      });
    case "openai":
      return new OpenAIChatProvider({
        apiKey: requireKey(),
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {})
      });
    case "openai-compatible":
      if (!baseUrl || baseUrl.trim() === "") {
        throw new Error("openai-compatible requires a baseUrl.");
      }
      return new OpenAICompatibleChatProvider({
        apiKey: requireKey(),
        baseUrl,
        ...(model ? { model } : {})
      });
    case "ollama":
      // Local by default — apiKey optional.
      return new OllamaChatProvider({
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {})
      });
    case "gemini":
      return new GeminiChatProvider({
        apiKey: requireKey(),
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {})
      });
    default: {
      const _exhaustive: never = providerType;
      throw new Error(`Unsupported provider type: ${String(_exhaustive)}`);
    }
  }
}
