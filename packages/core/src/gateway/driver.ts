/**
 * High-level hosted-Gateway driver: runs an Agent Kit through the managed
 * inference loop, handling the create → turn → (tool_use ⇆ tool-result) → done
 * cycle. This is TRANSPORT + LOOP ONLY — it performs no local tool execution
 * itself. The caller supplies `executeTool`, which is where the host's local
 * "hands" live (the desktop's Rust local-hands in 2c-iii, consent-gated).
 *
 * Never log token values.
 */

import {
  createGatewaySession,
  streamTurn,
  submitToolResults,
  deleteGatewaySession,
  type GatewayToolDefinition,
  type GatewayToolResult,
  type GatewayToolUse,
  type TurnOutcome
} from "./client.js";
import type { GatewayRequestOptions } from "./http.js";
import type { GatewayStreamEvent } from "./sse.js";
import type { TokenStore } from "../market/types.js";

/**
 * The callback the host implements to execute a single tool_use locally. Return
 * either a `result` (success) or an `error` (failure); throwing is also caught
 * and surfaced as an error result so one bad tool can't abort the whole loop.
 *
 * The desktop (2c-iii) implements this over its Rust local-hands, gated on user
 * consent and the declared tool set.
 */
export type ExecuteTool = (
  toolUse: GatewayToolUse
) => Promise<{ result?: unknown; error?: string } | unknown>;

export interface RunAgentKitWithGatewayOptions extends GatewayRequestOptions {
  /** Base URL of the hosted web Forge that fronts the gateway. */
  gatewayBaseUrl?: string;
  systemPrompt?: string;
  kitContext?: string;
  tools: GatewayToolDefinition[];
  model: string;
  /** Billing mode; defaults to "managed". */
  billing?: "managed";
  /** The initial user input that kicks off the first turn. */
  input: string;
  /** Host-provided local tool executor (the desktop supplies its Rust hands). */
  executeTool: ExecuteTool;
  /** Receives every normalized stream event (text deltas, usage, etc.). */
  onEvent?: (event: GatewayStreamEvent) => void;
  /** Safety bound on tool_use round-trips before giving up. Default 64. */
  maxToolRounds?: number;
  /** Delete the session when the run finishes/throws. Default true. */
  closeSessionOnFinish?: boolean;
}

export interface RunAgentKitWithGatewayResult {
  sessionId: string;
  /** All text deltas concatenated, in stream order. */
  text: string;
  /** The terminal (non-tool_use) stop reason. */
  stopReason: string;
  /** Usage from the final turn, if the server emitted one. */
  usage?: Record<string, unknown>;
  /** Number of tool_use round-trips driven. */
  toolRounds: number;
}

/** Normalize whatever `executeTool` returns into a wire {@link GatewayToolResult}. */
function toToolResult(toolUseId: string, raw: unknown): GatewayToolResult {
  if (raw && typeof raw === "object" && ("result" in raw || "error" in raw)) {
    const r = raw as { result?: unknown; error?: string };
    if (typeof r.error === "string" && r.error.length > 0) {
      return { toolUseId, error: r.error };
    }
    return { toolUseId, result: r.result };
  }
  // A bare value is treated as the success result.
  return { toolUseId, result: raw };
}

/**
 * Drive a full Agent Kit run through the hosted gateway.
 *
 * Flow: create session → streamTurn(initial input) → while the terminal stop is
 * `tool_use`, call `executeTool` for each pending tool_use, POST the results via
 * submitToolResults, and continue — until a non-tool_use terminal stop. Text
 * deltas are streamed via `onEvent` and accumulated into the returned `text`.
 *
 * Throws {@link InsufficientCreditsError} (from the low-level calls) on a 402.
 */
export async function runAgentKitWithGateway(
  store: TokenStore,
  options: RunAgentKitWithGatewayOptions
): Promise<RunAgentKitWithGatewayResult> {
  const {
    input,
    executeTool,
    onEvent,
    tools,
    model,
    systemPrompt,
    kitContext,
    billing,
    gatewayBaseUrl,
    maxToolRounds = 64,
    closeSessionOnFinish = true,
    ...requestOptions
  } = options;

  let text = "";
  const collect = (event: GatewayStreamEvent): void => {
    if (event.type === "text") {
      text += (event as { delta?: string }).delta ?? "";
    }
    if (onEvent) onEvent(event);
  };

  const sessionId = await createGatewaySession(store, {
    ...requestOptions,
    gatewayBaseUrl,
    systemPrompt,
    kitContext,
    tools,
    model,
    billing
  });

  try {
    let outcome: TurnOutcome = await streamTurn(
      store,
      { ...requestOptions, gatewayBaseUrl, sessionId, input },
      collect
    );

    let toolRounds = 0;
    while (outcome.stopReason === "tool_use") {
      if (toolRounds >= maxToolRounds) {
        throw new Error(
          `Gateway run exceeded the tool-use round limit (${maxToolRounds}).`
        );
      }
      toolRounds += 1;

      const results: GatewayToolResult[] = [];
      for (const toolUse of outcome.toolUses) {
        let raw: unknown;
        try {
          raw = await executeTool(toolUse);
        } catch (err) {
          raw = { error: err instanceof Error ? err.message : String(err) };
        }
        results.push(toToolResult(toolUse.toolUseId, raw));
      }

      outcome = await submitToolResults(
        store,
        { ...requestOptions, gatewayBaseUrl, sessionId, results },
        collect
      );
    }

    return {
      sessionId,
      text,
      stopReason: outcome.stopReason,
      usage: outcome.usage,
      toolRounds
    };
  } finally {
    if (closeSessionOnFinish) {
      await deleteGatewaySession(store, {
        ...requestOptions,
        gatewayBaseUrl,
        sessionId
      }).catch(() => {
        // Best-effort teardown; never mask the real result/error.
      });
    }
  }
}
