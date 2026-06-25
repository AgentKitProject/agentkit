/**
 * `@agentkitforge/core/gateway` — hosted-AgentKitForge Gateway client.
 *
 * Lets NON-browser clients (desktop / CLI / Auto) run an Agent Kit through the
 * hosted, managed-billing inference loop with the tool-use cycle. The host
 * supplies an `executeTool` callback for local tool execution (the desktop's
 * Rust local-hands, 2c-iii); this module is transport + loop only.
 *
 * Auth mirrors `@agentkitforge/core/market`: device-auth bearer via the shared
 * {@link TokenStore}, once-on-401 refresh-and-retry. Turn/tool-result responses
 * are SSE streams parsed chunk-boundary-safe.
 */

export {
  DEFAULT_GATEWAY_BASE_URL,
  InsufficientCreditsError,
  ReconnectRequiredError,
  authedStreamingRequest,
  forgeGatewayRoutes,
  normalizeGatewayBaseUrl,
  throwIfInsufficientCredits,
  type GatewayRequestOptions,
  type StreamingFetchLike,
  type StreamingFetchResponse
} from "./http.js";

export { SseParser, type GatewayStreamEvent } from "./sse.js";

export {
  createGatewaySession,
  deleteGatewaySession,
  streamTurn,
  submitToolResults,
  type CreateGatewaySessionOptions,
  type DeleteGatewaySessionOptions,
  type GatewayToolDefinition,
  type GatewayToolResult,
  type GatewayToolUse,
  type StreamTurnOptions,
  type SubmitToolResultsOptions,
  type TurnOutcome
} from "./client.js";

export {
  runAgentKitWithGateway,
  type ExecuteTool,
  type RunAgentKitWithGatewayOptions,
  type RunAgentKitWithGatewayResult
} from "./driver.js";
