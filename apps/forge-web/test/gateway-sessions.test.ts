import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGatewaySession,
  routeGatewayRequest,
  type GatewaySession,
  type SessionStore,
  type StreamEvent
} from "@agentkitforge/gateway-core";
import { getKitStore } from "@/server/store/local-disk";
import { withEphemeralTree } from "@/server/core/runner";

// Gateway Phase 2b — composition-root wiring tests.
//
// These exercise the two pieces of glue this app owns:
//   1. resolveSystemPrompt — builds the kit system prompt SERVER-SIDE from the
//      caller's KitStore tree via @agentkitforge/core's buildAgentKitContext.
//   2. The router create-session path with this app's deps shape (entitlement
//      defaults to allow; the session is scoped to the caller's userId).
//
// We avoid the DynamoDB singletons by injecting an in-memory SessionStore here;
// the production composition (server/core/gateway-sessions.ts) wires the same
// deps over DynamoSessionStore.

let dataDir: string;
const USER = "user_gw_sessions_test";

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "akf-gw-sessions-"));
  process.env.AGENTKITFORGE_WEB_DATA_DIR = dataDir;
});

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Minimal in-memory SessionStore mirroring the DynamoSessionStore contract. */
function makeMemorySessionStore(): SessionStore {
  const sessions = new Map<string, GatewaySession>();
  let counter = 0;
  return {
    async createSession(input) {
      const session: GatewaySession = {
        sessionId: `sess_${++counter}`,
        userId: input.userId,
        kitId: input.kitId,
        kitSlug: input.kitSlug,
        systemPromptRef: input.systemPromptRef,
        billingMode: input.billingMode,
        byoProviderConfig: input.byoProviderConfig,
        messages: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        expiresAt: input.expiresAt
      };
      sessions.set(session.sessionId, session);
      return session;
    },
    async getSession(id) {
      return sessions.get(id);
    },
    async appendMessages(input) {
      const s = sessions.get(input.sessionId)!;
      s.messages.push(...input.messages);
      return s;
    },
    async replaceMessages(id, messages, updatedAt) {
      const s = sessions.get(id)!;
      s.messages = messages;
      s.updatedAt = updatedAt;
      return s;
    },
    async setTurnState(id, turnState, updatedAt) {
      const s = sessions.get(id)!;
      s.turnState = turnState;
      s.updatedAt = updatedAt;
      return s;
    },
    async deleteSession(id) {
      sessions.delete(id);
    }
  };
}

describe("gateway-sessions composition", () => {
  it("resolveSystemPrompt builds a non-empty kit system prompt from the store tree", async () => {
    const store = await getKitStore();
    const meta = await store.createKit(USER, {
      kind: "template",
      template: "blank",
      id: "chat-kit",
      name: "Chat Kit",
      description: "A kit for the gateway chat system-prompt build test."
    });
    const tree = await store.getKitTree(USER, meta.kitId);

    // Mirror resolveSystemPrompt's body (materialize tree → buildAgentKitContext).
    const { systemContext } = await withEphemeralTree(tree, async ({ kitRoot, core }) =>
      core.buildAgentKitContext({
        kitPath: kitRoot,
        mode: "all",
        target: "claude",
        includePolicies: true,
        includeTemplates: true,
        includeWorkflows: true,
        includePrompts: false
      })
    );

    expect(systemContext.trim().length).toBeGreaterThan(0);
    // The blank template's AGENTKIT.md content should be reflected in the prompt.
    expect(systemContext).toMatch(/agent kit|AGENTKIT|Chat Kit/i);
  });

  it("router create-session scopes the session to the caller and never returns the prompt", async () => {
    const sessions = makeMemorySessionStore();
    const events: StreamEvent[] = [];

    const res = await routeGatewayRequest(
      {
        session: { sessions, now: () => "2026-06-18T00:00:00.000Z" },
        // turn deps are not exercised by the create path; stub the shape.
        turn: {
          chatProvider: { streamMessage: async () => ({ content: [], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 } }) } as never,
          sessions,
          ledger: {} as never,
          resolveSystemPrompt: async () => "SECRET PROMPT",
          now: () => "2026-06-18T00:00:00.000Z",
          model: "claude-sonnet-4-6",
          maxTokens: 1024
        },
        createEmitter: () => ({ emit: (e) => events.push(e), close: () => {} })
      },
      { method: "POST", path: "/gateway/sessions", body: { kitId: "chat-kit", billing: "managed" }, userId: USER }
    );

    expect(res.kind).toBe("json");
    if (res.kind === "json") {
      expect(res.status).toBe(201);
      const body = res.body as { sessionId: string; kitId: string; billingMode: string } & Record<string, unknown>;
      expect(body.sessionId).toBeTruthy();
      expect(body.kitId).toBe("chat-kit");
      expect(body.billingMode).toBe("managed");
      // The injected system prompt must never cross the boundary.
      expect(JSON.stringify(body)).not.toContain("SECRET PROMPT");
      expect(body).not.toHaveProperty("systemPromptRef");
    }

    // The stored session is scoped to the caller.
    const created = await createGatewaySession(
      { sessions, now: () => "2026-06-18T00:00:00.000Z" },
      { userId: USER, kitId: "chat-kit", billing: "managed" }
    );
    expect(created.userId).toBe(USER);
  });
});
