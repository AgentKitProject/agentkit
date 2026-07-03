/**
 * Wave 4 messaging tests: inbound normalization (slack/telegram/discord incl.
 * bot-loop guards), trigger matching (scope/channel/events), approval-callback
 * parsing, outbound platform post payload shapes (chat.postMessage thread
 * reply / sendMessage reply_to_message_id / discord bot channel message,
 * Approve/Deny button structures), and the message_reply destination path in
 * the destination executor (origin from run.input.event; bot token revealed
 * from the SecretStore only).
 */

import { describe, expect, it } from "vitest";
import {
  buildApprovalCallbackData,
  defaultTargetFromConnectionConfig,
  messageTriggerMatches,
  normalizeMessageEvent,
  originFromMessagePayload,
  parseApprovalCallback,
  parseApprovalCallbackData,
  parseSlackInteractionPayload,
  postPlatformMessage,
  platformOfBotConnectionType,
} from "../src/core/messaging.js";
import { executeDestinations } from "../src/core/destination-executor.js";
import type { AutoRun, Connection, MessageTriggerConfig } from "../src/core/types.js";
import type { FetchFn } from "../src/core/http-fetch.js";
import { InMemoryConnectionRepo, InMemoryRunRepo, InMemorySecretStore } from "./fakes.js";

const NOW = "2026-07-03T12:00:00.000Z";

function captureFetch(status = 200, body = "{}"): { fn: FetchFn; calls: { url: string; init: Parameters<FetchFn>[1] }[] } {
  const calls: { url: string; init: Parameters<FetchFn>[1] }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return { status, headers: { forEach: () => {} }, text: async () => body };
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Inbound normalization
// ---------------------------------------------------------------------------

describe("normalizeMessageEvent", () => {
  it("slack event_callback → message payload {channel,threadTs,user,text,ts}", () => {
    const n = normalizeMessageEvent("slack", {
      type: "event_callback",
      event: { type: "message", channel: "C1", user: "U1", text: "hello", ts: "111.222" },
    });
    expect(n).not.toBeNull();
    expect(n!.eventName).toBe("message");
    expect(n!.payload).toEqual({ channel: "C1", threadTs: "111.222", user: "U1", text: "hello", ts: "111.222" });
    expect(n!.origin).toEqual({ platform: "slack", channel: "C1", threadTs: "111.222" });
    expect(n!.isMention).toBe(false);
  });

  it("slack app_mention keeps thread_ts; bot/self + subtype messages never fire (loop guard)", () => {
    const mention = normalizeMessageEvent("slack", {
      type: "event_callback",
      event: { type: "app_mention", channel: "C1", user: "U1", text: "<@BOT> do it", ts: "3.4", thread_ts: "1.2" },
    });
    expect(mention!.isMention).toBe(true);
    expect(mention!.origin).toEqual({ platform: "slack", channel: "C1", threadTs: "1.2" });

    expect(
      normalizeMessageEvent("slack", {
        type: "event_callback",
        event: { type: "message", channel: "C1", bot_id: "B9", text: "loop", ts: "5.6" },
      }),
    ).toBeNull();
    expect(
      normalizeMessageEvent("slack", {
        type: "event_callback",
        event: { type: "message", channel: "C1", subtype: "message_changed", text: "e", ts: "5.6" },
      }),
    ).toBeNull();
    // Handshake payloads are not messages.
    expect(normalizeMessageEvent("slack", { type: "url_verification", challenge: "c" })).toBeNull();
  });

  it("telegram update → {chatId,messageId,from,text}; bots and non-text skipped", () => {
    const n = normalizeMessageEvent("telegram", {
      update_id: 5,
      message: {
        message_id: 42,
        chat: { id: 987, type: "private" },
        from: { id: 1, username: "alice" },
        text: "run it",
      },
    });
    expect(n!.payload).toEqual({ chatId: "987", messageId: 42, from: "alice", text: "run it" });
    expect(n!.origin).toEqual({ platform: "telegram", chatId: "987", messageId: 42 });
    expect(n!.isDm).toBe(true);

    expect(
      normalizeMessageEvent("telegram", {
        message: { message_id: 1, chat: { id: 1 }, from: { is_bot: true }, text: "x" },
      }),
    ).toBeNull();
    expect(normalizeMessageEvent("telegram", { callback_query: { data: "x" } })).toBeNull();
  });

  it("discord APPLICATION_COMMAND → {channelId,guildId,user,content}; PING is not a message", () => {
    const n = normalizeMessageEvent("discord", {
      type: 2,
      channel_id: "CH1",
      guild_id: "G1",
      member: { user: { username: "bob" } },
      data: { name: "summarize", options: [{ name: "what", value: "the thread" }] },
    });
    expect(n!.payload).toEqual({ channelId: "CH1", guildId: "G1", user: "bob", content: "/summarize the thread" });
    expect(n!.origin).toEqual({ platform: "discord", channelId: "CH1" });
    expect(normalizeMessageEvent("discord", { type: 1 })).toBeNull();
    expect(normalizeMessageEvent("discord", { type: 3, data: { custom_id: "x" } })).toBeNull();
  });
});

describe("messageTriggerMatches", () => {
  const base: MessageTriggerConfig = { platform: "slack", sourceId: "src1", scope: "channel", connectionId: null, channelId: null };
  const msg = {
    eventName: "message",
    payload: {},
    origin: { platform: "slack", channel: "C1", threadTs: "1" } as const,
    channelId: "C1",
    isDm: false,
    isMention: false,
  };

  it("scope + channel + events filters", () => {
    expect(messageTriggerMatches(base, msg)).toBe(true);
    expect(messageTriggerMatches({ ...base, channelId: "C2" }, msg)).toBe(false);
    expect(messageTriggerMatches({ ...base, scope: "mention" }, msg)).toBe(false);
    expect(messageTriggerMatches({ ...base, scope: "mention" }, { ...msg, isMention: true })).toBe(true);
    expect(messageTriggerMatches({ ...base, scope: "dm" }, msg)).toBe(false);
    expect(messageTriggerMatches({ ...base, scope: "dm" }, { ...msg, isDm: true })).toBe(true);
    // Explicit events filter overrides scope.
    expect(messageTriggerMatches({ ...base, scope: "mention", events: ["message"] }, msg)).toBe(true);
    expect(messageTriggerMatches({ ...base, events: ["app_mention"] }, msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Approval callbacks
// ---------------------------------------------------------------------------

describe("approval callback parsing", () => {
  const token = "tok-123";

  it("round-trips callback data", () => {
    expect(parseApprovalCallbackData(buildApprovalCallbackData("approve", token))).toEqual({
      decision: "approve",
      token,
    });
    expect(parseApprovalCallbackData("akauto:deny:t")).toEqual({ decision: "deny", token: "t" });
    expect(parseApprovalCallbackData("akauto:maybe:t")).toBeNull();
    expect(parseApprovalCallbackData("other:approve:t")).toBeNull();
    expect(parseApprovalCallbackData("akauto:approve:")).toBeNull();
    expect(parseApprovalCallbackData(42)).toBeNull();
  });

  it("slack: block_actions form payload → decision", () => {
    const interaction = {
      type: "block_actions",
      actions: [{ action_id: "akauto_approve", value: buildApprovalCallbackData("approve", token) }],
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(interaction))}`;
    const parsed = parseSlackInteractionPayload(rawBody);
    expect(parseApprovalCallback("slack", parsed)).toEqual({ decision: "approve", token });
    expect(parseSlackInteractionPayload("not-a-form")).toBeNull();
  });

  it("telegram callback_query and discord component interactions parse; events do not", () => {
    expect(
      parseApprovalCallback("telegram", { callback_query: { data: buildApprovalCallbackData("deny", token) } }),
    ).toEqual({ decision: "deny", token });
    expect(
      parseApprovalCallback("discord", { type: 3, data: { custom_id: buildApprovalCallbackData("approve", token) } }),
    ).toEqual({ decision: "approve", token });
    expect(parseApprovalCallback("telegram", { message: { text: "hi" } })).toBeNull();
    expect(parseApprovalCallback("discord", { type: 2, data: { name: "cmd" } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outbound posts
// ---------------------------------------------------------------------------

describe("postPlatformMessage", () => {
  it("slack: chat.postMessage with channel + thread_ts + bearer bot token", async () => {
    const fetch = captureFetch(200, '{"ok":true}');
    const result = await postPlatformMessage({
      target: { platform: "slack", channel: "C1", threadTs: "1.2" },
      botToken: "xoxb-secret",
      text: "done",
      fetchImpl: fetch.fn,
    });
    expect(result.status).toBe("delivered");
    expect(fetch.calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(fetch.calls[0]!.init?.headers?.["authorization"]).toBe("Bearer xoxb-secret");
    const body = JSON.parse(fetch.calls[0]!.init?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ channel: "C1", text: "done", thread_ts: "1.2" });
  });

  it("slack: HTTP 200 with ok:false is a failure (API error surfaced)", async () => {
    const fetch = captureFetch(200, '{"ok":false,"error":"channel_not_found"}');
    const result = await postPlatformMessage({
      target: { platform: "slack", channel: "C1", threadTs: "" },
      botToken: "t",
      text: "x",
      fetchImpl: fetch.fn,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("channel_not_found");
  });

  it("telegram: sendMessage with chat_id + reply_to_message_id + inline keyboard", async () => {
    const fetch = captureFetch();
    await postPlatformMessage({
      target: { platform: "telegram", chatId: "987", messageId: 42 },
      botToken: "tg-token",
      text: "approve?",
      approval: {
        approveData: buildApprovalCallbackData("approve", "tok"),
        denyData: buildApprovalCallbackData("deny", "tok"),
      },
      fetchImpl: fetch.fn,
    });
    expect(fetch.calls[0]!.url).toBe("https://api.telegram.org/bottg-token/sendMessage");
    const body = JSON.parse(fetch.calls[0]!.init?.body ?? "{}") as Record<string, unknown>;
    expect(body["chat_id"]).toBe("987");
    expect(body["reply_to_message_id"]).toBe(42);
    const keyboard = (body["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] })
      .inline_keyboard[0]!;
    expect(keyboard.map((b) => b.text)).toEqual(["Approve", "Deny"]);
    expect(keyboard[0]!.callback_data).toBe("akauto:approve:tok");
  });

  it("discord: bot-token channel message with Approve/Deny components", async () => {
    const fetch = captureFetch();
    await postPlatformMessage({
      target: { platform: "discord", channelId: "CH9" },
      botToken: "d-token",
      text: "approve?",
      approval: { approveData: "akauto:approve:tok", denyData: "akauto:deny:tok" },
      fetchImpl: fetch.fn,
    });
    expect(fetch.calls[0]!.url).toBe("https://discord.com/api/v10/channels/CH9/messages");
    expect(fetch.calls[0]!.init?.headers?.["authorization"]).toBe("Bot d-token");
    const body = JSON.parse(fetch.calls[0]!.init?.body ?? "{}") as Record<string, unknown>;
    const row = (body["components"] as { components: { label: string; custom_id: string }[] }[])[0]!;
    expect(row.components.map((c) => c.label)).toEqual(["Approve", "Deny"]);
  });

  it("slack approval prompts carry block-kit Approve/Deny actions", async () => {
    const fetch = captureFetch(200, '{"ok":true}');
    await postPlatformMessage({
      target: { platform: "slack", channel: "C1", threadTs: "1.2" },
      botToken: "t",
      text: "approve?",
      approval: { approveData: "akauto:approve:tok", denyData: "akauto:deny:tok" },
      fetchImpl: fetch.fn,
    });
    const body = JSON.parse(fetch.calls[0]!.init?.body ?? "{}") as Record<string, unknown>;
    const blocks = body["blocks"] as { type: string; elements?: { text: { text: string }; value: string }[] }[];
    const actions = blocks.find((b) => b.type === "actions")!;
    expect(actions.elements!.map((e) => e.text.text)).toEqual(["Approve", "Deny"]);
    expect(actions.elements![0]!.value).toBe("akauto:approve:tok");
  });

  it("never throws on fetch failure; long text is truncated", async () => {
    const failing: FetchFn = async () => {
      throw new Error("network down");
    };
    const result = await postPlatformMessage({
      target: { platform: "telegram", chatId: "1" },
      botToken: "t",
      text: "x",
      fetchImpl: failing,
    });
    expect(result.status).toBe("failed");

    const fetch = captureFetch();
    await postPlatformMessage({
      target: { platform: "discord", channelId: "C" },
      botToken: "t",
      text: "y".repeat(5000),
      fetchImpl: fetch.fn,
    });
    const body = JSON.parse(fetch.calls[0]!.init?.body ?? "{}") as { content: string };
    expect(body.content.length).toBeLessThan(2000);
    expect(body.content.endsWith("…[truncated]")).toBe(true);
  });
});

describe("origin + target helpers", () => {
  it("originFromMessagePayload reconstructs per platform", () => {
    expect(originFromMessagePayload("slack", { channel: "C1", threadTs: "1.2" })).toEqual({
      platform: "slack",
      channel: "C1",
      threadTs: "1.2",
    });
    expect(originFromMessagePayload("telegram", { chatId: "9", messageId: 4 })).toEqual({
      platform: "telegram",
      chatId: "9",
      messageId: 4,
    });
    expect(originFromMessagePayload("discord", { channelId: "CH" })).toEqual({
      platform: "discord",
      channelId: "CH",
    });
    expect(originFromMessagePayload("slack", { nope: true })).toBeUndefined();
  });

  it("defaultTargetFromConnectionConfig reads per-platform defaults", () => {
    expect(defaultTargetFromConnectionConfig("slack", { channelId: "C7" })).toEqual({
      platform: "slack",
      channel: "C7",
      threadTs: "",
    });
    expect(defaultTargetFromConnectionConfig("telegram", { chatId: "5" })).toEqual({
      platform: "telegram",
      chatId: "5",
    });
    expect(defaultTargetFromConnectionConfig("discord", {})).toBeUndefined();
  });

  it("platformOfBotConnectionType maps bot connection types", () => {
    expect(platformOfBotConnectionType("slack_bot")).toBe("slack");
    expect(platformOfBotConnectionType("telegram_bot")).toBe("telegram");
    expect(platformOfBotConnectionType("discord_bot")).toBe("discord");
    expect(platformOfBotConnectionType("s3")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// message_reply destination (executor)
// ---------------------------------------------------------------------------

describe("message_reply destination", () => {
  function makeRun(origin: unknown): AutoRun {
    return {
      id: "run-1",
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      status: "succeeded",
      input: { prompt: "p", ...(origin !== undefined ? { event: { name: "message", origin } } : {}) },
      budgetCents: 100,
      spentCents: 5,
      model: "m",
      createdAt: NOW,
      auditLog: [],
    } as AutoRun;
  }

  function botConnection(type: string, secretRef: string | null = "sref-1"): Connection {
    return {
      id: "conn-bot",
      ownerType: "user",
      ownerId: "u1",
      name: "bot",
      type,
      config: {},
      secretRef,
      status: "ok",
      createdAt: NOW,
    } as Connection;
  }

  async function execute(run: AutoRun, connection: Connection | null, fetch = captureFetch(200, '{"ok":true}')) {
    const runs = new InMemoryRunRepo();
    const connections = new InMemoryConnectionRepo();
    const secrets = new InMemorySecretStore();
    if (connection) {
      connections.seed(connection);
      secrets.secrets.set("sref-1", "bot-token-secret");
    }
    const outcomes = await executeDestinations({
      run,
      destinations: [{ type: "message_reply", connectionId: "conn-bot", replyToOrigin: true }],
      result: { status: "succeeded", output: "summary text", spentCents: 5 },
      outputFiles: [],
      deps: { runs, connections, secrets, fetchImpl: fetch.fn },
      now: () => NOW,
    });
    return { outcomes, fetch };
  }

  it("posts the run summary back to the slack origin thread via the bot token (S2)", async () => {
    const { outcomes, fetch } = await execute(
      makeRun({ platform: "slack", channel: "C1", threadTs: "1.2" }),
      botConnection("slack_bot"),
    );
    expect(outcomes[0]).toMatchObject({ type: "message_reply", status: "delivered" });
    expect(fetch.calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(fetch.calls[0]!.init?.headers?.["authorization"]).toBe("Bearer bot-token-secret");
    const body = JSON.parse(fetch.calls[0]!.init?.body ?? "{}") as Record<string, unknown>;
    expect(body["channel"]).toBe("C1");
    expect(body["thread_ts"]).toBe("1.2");
    expect(String(body["text"])).toContain("summary text");
  });

  it("telegram origin replies to the originating message", async () => {
    const { outcomes, fetch } = await execute(
      makeRun({ platform: "telegram", chatId: "987", messageId: 42 }),
      botConnection("telegram_bot"),
    );
    expect(outcomes[0]!.status).toBe("delivered");
    const body = JSON.parse(fetch.calls[0]!.init?.body ?? "{}") as Record<string, unknown>;
    expect(body["chat_id"]).toBe("987");
    expect(body["reply_to_message_id"]).toBe(42);
  });

  it("skips runs without an origin; fails on platform mismatch / non-bot connections / missing token", async () => {
    const noOrigin = await execute(makeRun(undefined), botConnection("slack_bot"));
    expect(noOrigin.outcomes[0]!.status).toBe("skipped");

    const mismatch = await execute(
      makeRun({ platform: "telegram", chatId: "9" }),
      botConnection("slack_bot"),
    );
    expect(mismatch.outcomes[0]!.status).toBe("failed");

    const notBot = await execute(
      makeRun({ platform: "slack", channel: "C1", threadTs: "1" }),
      botConnection("slack_incoming"),
    );
    expect(notBot.outcomes[0]!.status).toBe("failed");
    expect(notBot.outcomes[0]!.error).toContain("bot connection");

    const noToken = await execute(
      makeRun({ platform: "slack", channel: "C1", threadTs: "1" }),
      botConnection("slack_bot", null),
    );
    expect(noToken.outcomes[0]!.status).toBe("failed");
  });

  it("cross-user connections are refused (ownership)", async () => {
    const foreign = botConnection("slack_bot");
    (foreign as { ownerId: string }).ownerId = "someone-else";
    const { outcomes } = await execute(
      makeRun({ platform: "slack", channel: "C1", threadTs: "1" }),
      foreign,
    );
    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.error).toContain("not owned");
  });
});
