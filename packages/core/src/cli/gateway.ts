/**
 * `agentkitforge gateway run …` — run an Agent Kit through the hosted, managed-
 * billing Gateway from a terminal. Text streams to stdout as it arrives.
 *
 * The CLI has no local "hands" (the desktop supplies those via its Rust
 * local-hands in 2c-iii), so this command runs TEXT-ONLY: it declares no tools
 * and rejects any tool_use the model attempts. It exists for parity with the
 * market run-style commands and as a smoke path for the gateway transport.
 *
 * Never log token values.
 */

import { Command } from "commander";

import { buildAgentKitContext } from "../context/builder.js";
import {
  InsufficientCreditsError,
  ReconnectRequiredError,
  runAgentKitWithGateway
} from "../gateway/index.js";
import {
  createDefaultTokenStore,
  ensureAccessToken
} from "../market/index.js";
import { resolveClientId } from "./market.js";

const DEFAULT_GATEWAY_MODEL = "claude-opus-4-8";

/** Resolve the gateway base URL: flag → env → default hosted web Forge. */
function resolveGatewayBaseUrl(flag?: string): string | undefined {
  const candidate = flag?.trim() || process.env.AGENTKITFORGE_GATEWAY_BASE_URL?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}

/** Register the `gateway` command group onto an existing program. */
export function registerGatewayCommands(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("Hosted Gateway: run an Agent Kit through managed inference");

  gateway
    .command("run")
    .description(
      "Run an Agent Kit through the hosted gateway (text-only; the CLI has no " +
        "local tools). Streams the model's text to stdout."
    )
    .argument("<kitPath>", "Agent Kit folder")
    .requiredOption("--input <text>", "User input to send to the kit")
    .option("--gateway-url <url>", "Gateway base URL (web Forge host)")
    .option("--model <model>", "Model id", DEFAULT_GATEWAY_MODEL)
    .option("--system <text>", "Override system prompt (skips kit context build)")
    .action(
      async (
        kitPath: string,
        options: { input: string; gatewayUrl?: string; model: string; system?: string }
      ) => {
        const clientId = resolveClientId();
        const store = createDefaultTokenStore();
        try {
          await ensureAccessToken(store, { clientId });
        } catch (error) {
          if (error instanceof ReconnectRequiredError) {
            throw new ReconnectRequiredError(
              "Not connected. Run `agentkitforge market login` first."
            );
          }
          throw error;
        }

        let systemPrompt = options.system?.trim();
        if (!systemPrompt) {
          const context = await buildAgentKitContext({
            kitPath,
            mode: "all",
            target: "claude"
          });
          systemPrompt = context.systemContext;
        }

        try {
          const result = await runAgentKitWithGateway(store, {
            clientId,
            gatewayBaseUrl: resolveGatewayBaseUrl(options.gatewayUrl),
            systemPrompt,
            tools: [],
            model: options.model,
            input: options.input,
            executeTool: async (toolUse) => ({
              error:
                `The CLI cannot execute tools (no local hands). The model requested ` +
                `'${toolUse.name}'. Run kits with tools from the desktop app instead.`
            }),
            onEvent: (event) => {
              if (event.type === "text") {
                process.stdout.write((event as { delta?: string }).delta ?? "");
              }
            }
          });
          process.stdout.write("\n");
          console.error(`\n[stop: ${result.stopReason}; tool rounds: ${result.toolRounds}]`);
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            throw new Error(
              "Insufficient credits to run this kit through the hosted gateway."
            );
          }
          throw error;
        }
      }
    );
}

export { resolveGatewayBaseUrl };
