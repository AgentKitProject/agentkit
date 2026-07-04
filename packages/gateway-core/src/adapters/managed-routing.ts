// Model-aware managed ChatProvider — routes each request to the platform
// provider (Anthropic or OpenAI) that serves its model.
//
// Managed inference used to be Anthropic-only: the run driver and the Forge
// gateway constructed `createManagedAnthropicProvider()` directly. Offering
// managed GPT models means the SAME managed call site must dispatch by model.
// This wrapper is a drop-in replacement for those call sites: it implements the
// ChatProvider port and delegates `sendMessage`/`streamMessage` to the right
// underlying managed provider based on `request.model`.
//
// Billing is unaffected: `runManagedTurn` prices each turn from the gateway
// pricing table keyed on `request.model`, so as long as the model has a pricing
// row it is debited correctly regardless of which provider served it.

import type { ChatProvider, StreamEvent } from "../core/ports.js";
import type { ChatRequest, ChatResponse } from "../core/types.js";
import { createManagedAnthropicProvider } from "./anthropic/index.js";
import { createManagedOpenAIProvider } from "./openai/index.js";

export type ManagedProviderFamily = "anthropic" | "openai";

/**
 * Classify a canonical model id to the managed provider family that serves it.
 *
 * OpenAI: `gpt-*`, `chatgpt-*`, and the reasoning `o1/o3/o4` families.
 * Everything else falls through to Anthropic — this keeps the historical
 * Claude-only behavior (and any future Claude alias) working with no config.
 */
export function classifyManagedModelProvider(model: string): ManagedProviderFamily {
  const m = (model ?? "").trim().toLowerCase();
  if (
    m.startsWith("gpt-") ||
    m.startsWith("gpt4") ||
    m.startsWith("chatgpt") ||
    /^o[134](?:[.-]|$)/.test(m)
  ) {
    return "openai";
  }
  return "anthropic";
}

/**
 * Constructs a managed ChatProvider that dispatches by model.
 *
 * Each underlying provider is built LAZILY on first use for its family, so a
 * deployment that only provisions `ANTHROPIC_API_KEY` still serves every Claude
 * model; an OpenAI (`gpt-*`) request is the only thing that requires
 * `OPENAI_API_KEY`, and it throws the OpenAI adapter's clear inert error if the
 * key is missing — without ever breaking Claude runs on the same box.
 *
 * Drop-in for `createManagedAnthropicProvider()` at the managed call sites (the
 * auto-core run driver and the Forge gateway).
 */
export function createManagedRoutingProvider(options?: {
  env?: Record<string, string | undefined>;
}): ChatProvider {
  const env = options?.env ?? process.env;
  let anthropic: ChatProvider | undefined;
  let openai: ChatProvider | undefined;

  const providerFor = (model: string): ChatProvider => {
    if (classifyManagedModelProvider(model) === "openai") {
      openai ??= createManagedOpenAIProvider({ env });
      return openai;
    }
    anthropic ??= createManagedAnthropicProvider({ env });
    return anthropic;
  };

  return {
    providerType: "managed-routing",
    // `async` so a lazy-construction failure (missing key for the selected
    // family) surfaces as a rejected promise the awaiting caller catches —
    // rather than a synchronous throw — matching the run driver / streaming turn
    // error handling.
    async sendMessage(request: ChatRequest): Promise<ChatResponse> {
      return providerFor(request.model).sendMessage(request);
    },
    async streamMessage(
      request: ChatRequest,
      onEvent: (event: StreamEvent) => void,
    ): Promise<ChatResponse> {
      return providerFor(request.model).streamMessage(request, onEvent);
    },
  };
}
