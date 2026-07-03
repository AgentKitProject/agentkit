/**
 * Pure builders + copy for the MESSAGING wizard trigger kind (kind "message" —
 * Slack / Telegram / Discord; lib/automations/messaging.ts). This is the most
 * complex wizard flow: an inbound provider EventSource + an outbound bot
 * Connection + the message trigger config + a message_reply destination +
 * pre-run approval. Every built object must — wrapped in the wizard's base
 * fields where relevant — pass the contracts schemas, and secret material (the
 * provider signing secret AND the bot token) must NEVER land in a `config`.
 */
import { describe, expect, it } from "vitest";
import {
  connectionTypeSchema,
  createConnectionRequestSchema,
  createEventSourceRequestSchema,
  createTriggerRequestSchema,
  destinationSchema,
  messagePlatformSchema,
  messageTriggerConfigSchema,
  type Destination,
  type MessagePlatform
} from "@agentkitforge/contracts";
import {
  botConnectionType,
  buildBotConnectionRequest,
  buildMessageConfig,
  buildMessageReplyDestination,
  buildMessageSourceRequest,
  isBotConnectionType,
  MESSAGE_PLATFORMS,
  messagePlatformInfo,
  messageSourceInstructions,
  messageWhenReady,
  normalizeEvents,
  parseEventsInput,
  platformOfBotConnectionType,
  validateBotConnectionFields,
  withReplyDestination
} from "@/lib/automations/messaging";
import { buildTriggerMapping } from "@/lib/automations/watch-connect";

const PLATFORMS: MessagePlatform[] = ["slack", "telegram", "discord"];

/** The wizard's base fields shared by every create request. */
const BASE = {
  name: "Support triage",
  kitRef: { source: "local" as const, localKitId: "kit1" },
  approvalId: "appr1",
  mapping: buildTriggerMapping("Reply to {{text}}", true),
  enabled: true
};

// ---------------------------------------------------------------------------
// Platform table
// ---------------------------------------------------------------------------

describe("message platforms", () => {
  it("MESSAGE_PLATFORMS exactly covers the contract's messagePlatformSchema", () => {
    const built = MESSAGE_PLATFORMS.map((p) => p.platform).sort();
    expect(built).toEqual(["discord", "slack", "telegram"]);
    for (const p of MESSAGE_PLATFORMS) {
      expect(messagePlatformSchema.safeParse(p.platform).success).toBe(true);
    }
  });

  it("each platform carries its OWN signing-secret + bot-token labels (they mean different things)", () => {
    // The signing secret means: Slack = app Signing Secret, Telegram = webhook
    // secret_token, Discord = application Public Key.
    expect(messagePlatformInfo("slack")?.signingSecretLabel).toMatch(/signing secret/i);
    expect(messagePlatformInfo("telegram")?.signingSecretLabel).toMatch(/secret token/i);
    expect(messagePlatformInfo("discord")?.signingSecretLabel).toMatch(/public key/i);
    // And every platform labels its bot token.
    for (const p of MESSAGE_PLATFORMS) {
      expect(p.botTokenLabel.toLowerCase()).toContain("token");
    }
  });
});

// ---------------------------------------------------------------------------
// Inbound event source
// ---------------------------------------------------------------------------

describe("inbound message source (provider event source)", () => {
  it.each(PLATFORMS)("builds a contract-valid provider source carrying the signing secret (%s)", (platform) => {
    const req = buildMessageSourceRequest({ name: "  My source  ", platform, signingSecret: "  s3cr3t  " });
    expect(createEventSourceRequestSchema.safeParse(req).success).toBe(true);
    expect(req.kind).toBe("provider");
    expect(req.provider).toBe(platform);
    expect(req.name).toBe("My source");
    // The write-only signing secret is trimmed and carried (never in a config).
    expect(req.signingSecret).toBe("s3cr3t");
  });

  it("defaults the name from the platform when blank, and omits an empty signing secret", () => {
    const req = buildMessageSourceRequest({ name: "  ", platform: "slack", signingSecret: "  " });
    expect(req.name).toMatch(/slack/i);
    expect("signingSecret" in req).toBe(false);
    expect(createEventSourceRequestSchema.safeParse(req).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Outbound bot connection
// ---------------------------------------------------------------------------

describe("bot connection", () => {
  it("botConnectionType / platformOfBotConnectionType round-trip and match the contract", () => {
    for (const platform of PLATFORMS) {
      const type = botConnectionType(platform);
      expect(connectionTypeSchema.safeParse(type).success).toBe(true);
      expect(platformOfBotConnectionType(type)).toBe(platform);
      expect(isBotConnectionType(type)).toBe(true);
    }
    // Non-bot types are not bot connections.
    expect(isBotConnectionType("s3")).toBe(false);
    expect(isBotConnectionType("slack_incoming")).toBe(false);
    expect(platformOfBotConnectionType("s3")).toBeUndefined();
  });

  it.each(PLATFORMS)("builds a contract-valid bot connection; the bot TOKEN rides in `secret`, never in config (%s)", (platform) => {
    const req = buildBotConnectionRequest({
      name: `  ${platform} bot  `,
      platform,
      botToken: "  xoxb-super-secret  ",
      defaultChannelId: " C123 "
    });
    const parsed = createConnectionRequestSchema.safeParse(req);
    expect(parsed.success).toBe(true);
    expect(req.type).toBe(`${platform}_bot`);
    expect(req.name).toBe(`${platform} bot`);
    // S2: the token is the write-only secret (trimmed), NOT in config.
    expect(req.secret).toBe("xoxb-super-secret");
    expect(JSON.stringify(req.config)).not.toContain("xoxb-super-secret");
    // Non-secret config carries only the optional default channel id.
    expect(req.config).toEqual({ channelId: "C123" });
  });

  it("omits the default channel id when blank (empty config still valid)", () => {
    const req = buildBotConnectionRequest({ name: "b", platform: "slack", botToken: "t" });
    expect(req.config).toEqual({});
    expect(createConnectionRequestSchema.safeParse(req).success).toBe(true);
  });

  it("validateBotConnectionFields flags a missing name or token, else null", () => {
    const ok = { name: "n", platform: "slack" as const, botToken: "t" };
    expect(validateBotConnectionFields(ok)).toBeNull();
    expect(validateBotConnectionFields({ ...ok, name: " " })).toMatch(/name/i);
    expect(validateBotConnectionFields({ ...ok, botToken: "" })).toMatch(/token/i);
  });
});

// ---------------------------------------------------------------------------
// Message trigger config
// ---------------------------------------------------------------------------

describe("message trigger config", () => {
  it.each(PLATFORMS)("builds a contract-valid config per platform with scope + channel + events (%s)", (platform) => {
    const cfg = buildMessageConfig({
      platform,
      sourceId: "src-1",
      connectionId: " conn-1 ",
      scope: "mention",
      channelId: " C42 ",
      events: [" message ", "app_mention", "message"]
    });
    expect(messageTriggerConfigSchema.safeParse(cfg).success).toBe(true);
    expect(cfg).toEqual({
      platform,
      sourceId: "src-1",
      connectionId: "conn-1",
      scope: "mention",
      channelId: "C42",
      events: ["message", "app_mention"] // trimmed + de-duped
    });
  });

  it("omits connectionId/channelId/events when blank (scope default = channel)", () => {
    const cfg = buildMessageConfig({ platform: "slack", sourceId: "src-1", scope: "channel" });
    expect(cfg).toEqual({ platform: "slack", sourceId: "src-1", scope: "channel" });
    expect("connectionId" in cfg).toBe(false);
    expect("channelId" in cfg).toBe(false);
    expect("events" in cfg).toBe(false);
    expect(messageTriggerConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it("normalizeEvents trims, de-dupes, drops over-long, and caps at 10", () => {
    expect(normalizeEvents([" a ", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizeEvents(["x".repeat(65)])).toEqual([]); // > 64 chars dropped
    const many = Array.from({ length: 15 }, (_, i) => `e${i}`);
    expect(normalizeEvents(many)).toHaveLength(10);
  });

  it("parseEventsInput splits on commas/whitespace", () => {
    expect(parseEventsInput(" message, app_mention\n command ")).toEqual(["message", "app_mention", "command"]);
    expect(parseEventsInput("   ")).toEqual([]);
  });

  it.each(PLATFORMS)("a full message create request passes the create-trigger contract (%s)", (platform) => {
    const req = {
      ...BASE,
      type: "message" as const,
      config: buildMessageConfig({ platform, sourceId: "src-1", connectionId: "conn-1", scope: "channel" }),
      requireApproval: true,
      destinations: [buildMessageReplyDestination("conn-1")]
    };
    expect(createTriggerRequestSchema.safeParse(req).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reply destination
// ---------------------------------------------------------------------------

describe("message_reply destination", () => {
  it("builds a contract-valid message_reply destination (replyToOrigin true)", () => {
    const dest = buildMessageReplyDestination("conn-9");
    expect(destinationSchema.safeParse(dest).success).toBe(true);
    expect(dest).toEqual({ type: "message_reply", connectionId: "conn-9", replyToOrigin: true });
  });

  it("withReplyDestination adds the reply ONLY when enabled AND a connection is set", () => {
    const normal: Destination[] = [{ type: "email", to: ["ops@example.com"] }];
    // Enabled + connection → reply prepended, normal destinations kept.
    const withReply = withReplyDestination(normal, true, "conn-1");
    expect(withReply[0]).toEqual({ type: "message_reply", connectionId: "conn-1", replyToOrigin: true });
    expect(withReply).toHaveLength(2);
    // Disabled → reply removed (only normal destinations remain).
    expect(withReplyDestination(normal, false, "conn-1")).toEqual(normal);
    // No connection → reply removed even if enabled.
    expect(withReplyDestination(normal, true, "")).toEqual(normal);
    expect(withReplyDestination(normal, true, null)).toEqual(normal);
  });

  it("withReplyDestination is idempotent — never adds a second message_reply", () => {
    const already: Destination[] = [
      { type: "message_reply", connectionId: "old", replyToOrigin: true },
      { type: "email", to: ["a@example.com"] }
    ];
    const next = withReplyDestination(already, true, "new");
    expect(next.filter((d) => d.type === "message_reply")).toHaveLength(1);
    expect(next[0]).toEqual({ type: "message_reply", connectionId: "new", replyToOrigin: true });
  });

  it("withReplyDestination counts toward the max — a full (5) list becomes 6, so the UI must reserve a slot", () => {
    // Contract caps destinations at 5. withReplyDestination does NOT cap (it
    // just prepends), so the wizard reserves a slot when reply will inject
    // (addDestination max 4) + guards submit. This locks the injecting behavior
    // that motivated that reservation.
    const five: Destination[] = Array.from({ length: 5 }, (_, i) => ({
      type: "email" as const,
      to: [`a${i}@example.com`],
    }));
    expect(withReplyDestination(five, true, "conn-1")).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// whenReady gating
// ---------------------------------------------------------------------------

describe("messageWhenReady gating", () => {
  it("requires a platform and a source", () => {
    expect(messageWhenReady({ platform: null, sourceId: "s", connectionId: "c", replyEnabled: false, requireApproval: false })).toBe(false);
    expect(messageWhenReady({ platform: "slack", sourceId: "", connectionId: "c", replyEnabled: false, requireApproval: false })).toBe(false);
    // Source only, no reply/approval → ready (bot connection optional).
    expect(messageWhenReady({ platform: "slack", sourceId: "s", connectionId: null, replyEnabled: false, requireApproval: false })).toBe(true);
  });

  it("requires a bot connection ONLY when reply or approval is on", () => {
    // Reply on, no connection → not ready.
    expect(messageWhenReady({ platform: "slack", sourceId: "s", connectionId: "", replyEnabled: true, requireApproval: false })).toBe(false);
    // Approval on, no connection → not ready.
    expect(messageWhenReady({ platform: "slack", sourceId: "s", connectionId: "", replyEnabled: false, requireApproval: true })).toBe(false);
    // Reply on WITH a connection → ready.
    expect(messageWhenReady({ platform: "slack", sourceId: "s", connectionId: "c", replyEnabled: true, requireApproval: false })).toBe(true);
    // Approval on WITH a connection → ready.
    expect(messageWhenReady({ platform: "slack", sourceId: "s", connectionId: "c", replyEnabled: false, requireApproval: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-platform setup instructions
// ---------------------------------------------------------------------------

describe("per-platform inbound instructions", () => {
  const url = "https://auto.example.com/api/hooks/auto/events/src-1/message?token=abc";

  it("substitutes the real ingest URL and describes each platform's setup", () => {
    const slack = messageSourceInstructions("slack", url).join("\n");
    expect(slack).toContain(url);
    expect(slack).toMatch(/event subscriptions/i);
    expect(slack).toMatch(/message\.channels|app_mention/);
    expect(slack).toMatch(/url_verification/i); // handshake automatic

    const telegram = messageSourceInstructions("telegram", url).join("\n");
    expect(telegram).toContain(url);
    expect(telegram).toMatch(/setWebhook/);
    expect(telegram).toMatch(/secret_token/);

    const discord = messageSourceInstructions("discord", url).join("\n");
    expect(discord).toContain(url);
    expect(discord).toMatch(/interactions endpoint/i);
    expect(discord).toMatch(/ping/i); // handshake automatic
  });
});
