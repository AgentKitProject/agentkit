import { pathToFileURL } from "node:url";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * Long-lived hosted-Gateway run bridge (Phase 2c-iii — desktop Run/Chat).
 *
 * Unlike the one-shot `market-operation.mjs` (one request → one response), an
 * agent run STREAMS events and must round-trip tool execution mid-run. So this
 * bridge is bidirectional and line-oriented (JSONL):
 *
 *   STDIN  (from the Rust host):
 *     - first line: the START envelope
 *         { "op": "start",
 *           "session": { accessToken, refreshToken?, user?, connectedAt? },
 *           "params": { kitContext?, systemPrompt?, model, input, tools?,
 *                       gatewayBaseUrl?, clientId?, maxToolRounds? } }
 *     - subsequent lines: TOOL RESULTS the host produced (consent + local-hands
 *         happen entirely on the Rust side):
 *         { "type": "tool_result", "toolUseId": "...", "result"?: <json> }
 *       or
 *         { "type": "tool_result", "toolUseId": "...", "error": "<message>" }
 *
 *   STDOUT (to the Rust host), one JSON object per line:
 *     { "type": "text",         "delta": "..." }              // streamed text
 *     { "type": "tool_use",     "toolUseId", "name", "input" } // execute locally
 *     { "type": "usage",        ... }
 *     { "type": "rotated",      "session": <session> }         // refreshed token
 *     { "type": "done",         "stopReason", "toolRounds", "usage"? }
 *     { "type": "error",        "message", "code"? }
 *
 * Access/refresh tokens NEVER appear in argv or in any emitted event. The host
 * seeds the store with the stored session; core owns refresh; a refresh is
 * reported back as a `rotated` line so the host re-persists it to secure storage.
 *
 * Tool execution: the driver calls `executeTool(toolUse)`. We emit a `tool_use`
 * line and then BLOCK until the host writes a matching `tool_result` line. All
 * security (workspace path-scoping, write/run consent dialogs) lives in Rust;
 * this bridge only relays the request and waits for the trusted verdict.
 */

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") return null;
  const accessToken = typeof session.accessToken === "string" ? session.accessToken : "";
  if (accessToken.trim() === "") return null;
  return {
    accessToken,
    refreshToken: typeof session.refreshToken === "string" ? session.refreshToken : undefined,
    user: session.user && typeof session.user === "object" ? session.user : undefined,
    connectedAt:
      typeof session.connectedAt === "string" && session.connectedAt.trim() !== ""
        ? session.connectedAt
        : new Date().toISOString(),
  };
}

/**
 * In-memory TokenStore seeded with the current session. A refresh that happens
 * mid-run is reported to the host as a `rotated` line so it is re-persisted.
 */
function createCaptureStore(initialSession) {
  let current = initialSession ? { ...initialSession } : null;
  return {
    async get() {
      return current ? { ...current } : null;
    },
    async set(session) {
      current = { ...session };
      emit({ type: "rotated", session: current });
    },
    async clear() {
      current = null;
    },
  };
}

/**
 * Resolve a pending tool_use by writing it to stdout and awaiting the host's
 * `tool_result` line. Returns the driver-shaped `{ result }` or `{ error }`.
 */
function createToolBridge() {
  const pending = new Map();
  return {
    /** Called when the host sends back a tool_result line. */
    resolve(line) {
      const id = typeof line.toolUseId === "string" ? line.toolUseId : "";
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (typeof line.error === "string" && line.error.length > 0) {
        entry({ error: line.error });
      } else {
        entry({ result: line.result });
      }
    },
    /** The driver's executeTool: emit the proposal, await the host verdict. */
    executeTool(toolUse) {
      return new Promise((resolve) => {
        pending.set(toolUse.toolUseId, resolve);
        emit({
          type: "tool_use",
          toolUseId: toolUse.toolUseId,
          name: toolUse.name,
          input: toolUse.input,
        });
      });
    },
  };
}

async function loadCore() {
  if (
    process.env.AGENTKITFORGE_ALLOW_DEV_OVERRIDES === "1" &&
    process.env.AGENTKITFORGE_CORE_PATH
  ) {
    const entry = path.join(process.env.AGENTKITFORGE_CORE_PATH, "dist", "index.js");
    return import(pathToFileURL(entry).href);
  }
  const siblingEntry = path.resolve(process.cwd(), "..", "agentkitforge-core", "dist", "index.js");
  try {
    return await import(pathToFileURL(siblingEntry).href);
  } catch {
    // Fall back to the installed package.
  }
  return import("@agentkitforge/core");
}

/**
 * Build the kit's system context from its workspace via core, scoped to the
 * user's task. Best-effort: if the kit can't be read (e.g. an invalid manifest),
 * we fall back to a conversational run with no kit context rather than failing.
 */
async function buildKitContext(workspacePath, userTask) {
  if (typeof workspacePath !== "string" || workspacePath.trim() === "") return undefined;
  try {
    const core = await loadCore();
    const result = await core.buildAgentKitContext({
      kitPath: workspacePath,
      userTask,
      mode: "triggered",
      target: "claude",
    });
    return result.systemContext;
  } catch {
    return undefined;
  }
}

async function loadCoreGateway() {
  if (
    process.env.AGENTKITFORGE_ALLOW_DEV_OVERRIDES === "1" &&
    process.env.AGENTKITFORGE_CORE_PATH
  ) {
    const entry = path.join(process.env.AGENTKITFORGE_CORE_PATH, "dist", "gateway", "index.js");
    return import(pathToFileURL(entry).href);
  }

  const siblingEntry = path.resolve(
    process.cwd(),
    "..",
    "agentkitforge-core",
    "dist",
    "gateway",
    "index.js",
  );
  try {
    return await import(pathToFileURL(siblingEntry).href);
  } catch {
    // Fall back to the installed package subpath.
  }
  return import("@agentkitforge/core/gateway");
}

async function main() {
  const rl = createInterface({ input: process.stdin });
  const toolBridge = createToolBridge();

  let started = false;
  let startEnvelope = null;
  let resolveStart;
  const startReady = new Promise((resolve) => {
    resolveStart = resolve;
  });

  rl.on("line", (raw) => {
    const text = raw.trim();
    if (text === "") return;
    let line;
    try {
      line = JSON.parse(text);
    } catch {
      return;
    }
    if (!started && line.op === "start") {
      started = true;
      startEnvelope = line;
      resolveStart();
      return;
    }
    if (line.type === "tool_result") {
      toolBridge.resolve(line);
    }
  });

  await startReady;

  const params = startEnvelope?.params ?? {};
  const session = normalizeSession(startEnvelope?.session);
  if (!session) {
    emit({ type: "error", message: "A signed-in AgentKitProject account is required.", code: "reconnect_required" });
    emit({ type: "done", stopReason: "error", toolRounds: 0 });
    rl.close();
    return;
  }

  const store = createCaptureStore(session);
  const gateway = await loadCoreGateway();

  // Assemble the kit's system context from its workspace if the host did not
  // supply one. Reuses core's context builder, scoped to the user's prompt.
  let kitContext = typeof params.kitContext === "string" ? params.kitContext : undefined;
  if (!kitContext && typeof params.systemPrompt !== "string") {
    kitContext = await buildKitContext(params.workspacePath, params.input);
  }

  try {
    const result = await gateway.runAgentKitWithGateway(store, {
      gatewayBaseUrl: params.gatewayBaseUrl,
      kitContext,
      systemPrompt: typeof params.systemPrompt === "string" ? params.systemPrompt : undefined,
      tools: Array.isArray(params.tools) ? params.tools : [],
      model: params.model,
      input: params.input,
      clientId: params.clientId,
      maxToolRounds: typeof params.maxToolRounds === "number" ? params.maxToolRounds : undefined,
      executeTool: (toolUse) => toolBridge.executeTool(toolUse),
      onEvent: (event) => {
        // Forward text + usage as they stream. tool_use is already emitted by
        // the tool bridge (with the blocking round-trip); avoid double-emitting.
        if (event.type === "text") {
          emit({ type: "text", delta: event.delta ?? "" });
        } else if (event.type === "usage") {
          emit({ type: "usage", usage: event });
        }
      },
    });
    emit({
      type: "done",
      stopReason: result.stopReason,
      toolRounds: result.toolRounds,
      usage: result.usage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : error?.name === "InsufficientCreditsError"
          ? "insufficient_credits"
          : error?.name === "ReconnectRequiredError"
            ? "reconnect_required"
            : undefined;
    emit({ type: "error", message, code });
    emit({ type: "done", stopReason: "error", toolRounds: 0 });
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  emit({ type: "error", message });
  emit({ type: "done", stopReason: "error", toolRounds: 0 });
  process.exit(1);
});
