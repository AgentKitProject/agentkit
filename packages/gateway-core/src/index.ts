/**
 * @agentkitforge/gateway-core public API surface.
 *
 * Exports:
 *   - Core types (types.ts)
 *   - Port interfaces (ports.ts)
 *   - Config (config.ts)
 *   - Pricing / metering service (pricing.ts)
 *   - AWS adapter (adapters/aws)
 *   - Postgres self-host adapter (adapters/selfhost/postgres)
 *   - Anthropic ChatProvider adapter (adapters/anthropic)
 *
 * Entrypoints (lambda, server) are available as subpath exports only:
 *   @agentkitforge/gateway-core/entrypoints/lambda
 *   @agentkitforge/gateway-core/entrypoints/server
 */

// Core types
export type {
  AiProviderType,
  AppendSessionMessagesInput,
  BillingMode,
  ByoProviderConfig,
  ChatRequest,
  ChatResponse,
  ConversationMessage,
  ContentBlock,
  CreateSessionInput,
  CreditAccount,
  CreditHold,
  CreditTransaction,
  CreditTransactionType,
  GatewaySession,
  RecordTransactionInput,
  TextBlock,
  TokenUsage,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
  TurnState,
} from "./core/types.js";

// Port interfaces
export type {
  ChatProvider,
  ConfigProvider,
  CreditLedgerRepository,
  SessionStore,
  StreamEvent,
} from "./core/ports.js";

// Config
export {
  DEFAULT_MARKUP_BPS,
  EnvConfigProvider,
  MIN_TOPUP_CENTS,
  PER_CALL_MAX_COST_CENTS,
  SESSION_TTL_SECONDS,
  loadSelfHostGatewayConfig,
} from "./core/config.js";
export type { SelfHostGatewayConfig } from "./core/config.js";

// Pricing / metering
export {
  computeDebitCents,
  computeMaxHoldCents,
  getModelPricing,
} from "./core/pricing.js";
export type { ModelPricing, UsageForPricing } from "./core/pricing.js";

// Managed-turn service (credit-gated, non-streaming inference flow)
export {
  runManagedTurn,
  InsufficientCreditsError,
} from "./core/services/managed-turn.js";
export type {
  ManagedTurnDeps,
  ManagedTurnInput,
  ManagedTurnResult,
} from "./core/services/managed-turn.js";

// Streaming turn / tool-loop state machine ("remote brain, local hands")
export {
  runStreamingTurn,
  resumeWithToolResults,
  SessionNotFoundError,
  InvalidTurnStateError,
} from "./core/services/streaming-turn.js";
export type {
  StreamingTurnDeps,
  StreamingTurnInput,
  StreamingTurnResult,
  ToolResultInput,
} from "./core/services/streaming-turn.js";

// Affordability pre-check (canStartRun — READ-ONLY run-start cost preflight)
export {
  checkAffordability,
  estimateRunStartCents,
  resolveManagedInferenceFloorCents,
  utcYearMonth,
  FREE_TRIAL_PERIOD_KEY,
  MANAGED_INFERENCE_FLOOR_CENTS,
  MANAGED_INFERENCE_FLOOR_ENV_VAR,
} from "./core/services/affordability.js";
export type {
  AffordabilityVerdict,
  CheckAffordabilityDeps,
  CheckAffordabilityInput,
  RunBillingMode,
  RunStartPricing,
} from "./core/services/affordability.js";

// Gateway session lifecycle + entitlement seam
export {
  createGatewaySession,
  deleteGatewaySession,
  EntitlementDeniedError,
} from "./core/services/gateway-session.js";
export type {
  CreateGatewaySessionDeps,
  CreateGatewaySessionRequest,
  EntitlementCheck,
  EntitlementCheckArgs,
} from "./core/services/gateway-session.js";

// Framework-agnostic gateway router
export { routeGatewayRequest } from "./core/router.js";
export type {
  GatewayRequest,
  GatewayResponse,
  GatewayJsonResponse,
  GatewayStreamResponse,
  GatewayRouterDeps,
  SseEmitter,
} from "./core/router.js";

// In-memory credit ledger adapter (default for free / BYO path)
export { InMemoryCreditLedgerRepository } from "./adapters/memory/credit-ledger.js";

// AWS adapter (session store only; the managed DynamoDB credit ledger is commercial)
export {
  DynamoSessionStore,
  createDynamoDBDocumentClient,
  loadDynamoTableNames,
  GATEWAY_TABLE_ENV_VARS,
} from "./adapters/aws/index.js";
export type { DynamoTableNames } from "./adapters/aws/index.js";

// Postgres self-host adapter (session store only; the managed Postgres credit ledger is commercial)
export {
  PostgresSessionStore,
} from "./adapters/selfhost/postgres.js";
export type { PgPool } from "./adapters/selfhost/postgres.js";

// Anthropic ChatProvider adapter
export {
  AnthropicChatProvider,
  AnthropicProviderError,
  createManagedAnthropicProvider,
} from "./adapters/anthropic/index.js";

// OpenAI (+ openai-compatible) ChatProvider adapter
export {
  OpenAIChatProvider,
  OpenAICompatibleChatProvider,
  OpenAIProviderError,
  createManagedOpenAIProvider,
} from "./adapters/openai/index.js";

// Ollama ChatProvider adapter
export {
  OllamaChatProvider,
  OllamaProviderError,
  createManagedOllamaProvider,
} from "./adapters/ollama/index.js";

// Gemini ChatProvider adapter
export {
  GeminiChatProvider,
  GeminiProviderError,
  createManagedGeminiProvider,
} from "./adapters/gemini/index.js";

// Multi-provider factory
export {
  buildChatProvider,
  type BuildChatProviderOptions,
} from "./adapters/build-chat-provider.js";
