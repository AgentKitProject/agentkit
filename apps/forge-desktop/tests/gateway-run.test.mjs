import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Phase 2c-iii — desktop Run/Chat through the hosted Gateway with local hands.
// These assert the streaming bridge protocol and the SECURITY-CRITICAL local
// tool guardrails are wired the way the design requires.

test("gateway run bridge speaks the JSONL streaming protocol", async () => {
  const bridge = await readFile("src-tauri/backend/gateway-run.mjs", "utf8");

  // Long-lived, line-oriented (not the one-shot market envelope).
  assert.match(bridge, /createInterface/);
  assert.match(bridge, /"op": "start"|line\.op === "start"/);
  // Emits text / tool_use / done / error as separate lines.
  assert.match(bridge, /type: "text"/);
  assert.match(bridge, /type: "tool_use"/);
  assert.match(bridge, /type: "done"/);
  // Round-trips tool results back in on stdin to resume the loop.
  assert.match(bridge, /type === "tool_result"|line\.type === "tool_result"/);
  // Drives core's gateway loop and forwards refreshed sessions as `rotated`.
  assert.match(bridge, /runAgentKitWithGateway/);
  assert.match(bridge, /type: "rotated"/);
  // Reuses core context building from the kit workspace.
  assert.match(bridge, /buildAgentKitContext/);
});

test("gateway run command is registered and account-gated", async () => {
  const lib = await readFile("src-tauri/src/lib.rs", "utf8");
  assert.match(lib, /mod gateway_run;/);
  assert.match(lib, /run_agent_kit_with_gateway/);
  // Registered in the invoke handler.
  const handler = lib.slice(lib.indexOf(".invoke_handler"));
  assert.match(handler, /run_agent_kit_with_gateway/);
});

test("local-hands tools are workspace-scoped with traversal guards", async () => {
  const src = await readFile("src-tauri/src/gateway_run.rs", "utf8");

  // Requires a connected account (device-auth token) before running.
  assert.match(src, /current_session_json/);
  assert.match(src, /mark_reconnect_required/);

  // Path resolution rejects traversal/absolute/symlink escapes.
  assert.match(src, /resolve_in_workspace/);
  assert.match(src, /ParentDir/);
  assert.match(src, /starts_with\(workspace\)/);
  assert.match(src, /canonicalize/);

  // 402 → insufficient credits surfaced clearly.
  assert.match(src, /INSUFFICIENT_CREDITS|insufficient_credits/);
});

test("run_command is disabled by default and requires per-call consent", async () => {
  const src = await readFile("src-tauri/src/gateway_run.rs", "utf8");

  // run_command is only declared when explicitly enabled.
  assert.match(src, /if enable_run_command \{[\s\S]*run_command/);
  // Even enabled, it refuses to run without the enable flag...
  assert.match(src, /"run_command" => \{[\s\S]*if !enable_run_command/);
  // ...and writes + commands prompt a native confirm dialog showing the action.
  assert.match(src, /fn confirm_action/);
  assert.match(src, /rfd::MessageDialog/);
  assert.match(src, /Approve command/);
  assert.match(src, /Approve file write/);
});

test("client exposes a streaming gateway run seam", async () => {
  const types = await readFile("src/forge-client/types.ts", "utf8");
  assert.match(types, /runAgentKitWithGateway\(/);
  assert.match(types, /onEvent: \(event: GatewayRunEvent\) => void/);

  const client = await readFile("src/forge-client/tauri-client.ts", "utf8");
  // Subscribes to the scoped event channel BEFORE invoking, tears down after.
  assert.match(client, /gateway:\/\/event\/\$\{input\.runId\}/);
  assert.match(client, /run_agent_kit_with_gateway/);
  assert.match(client, /unlisten\(\)/);
});
