/**
 * Conversational messaging (Wave 4): inbound message normalization, message
 * trigger matching, approval-callback parsing, and outbound platform posts
 * (replies + Approve/Deny prompts) for Slack, Telegram, and Discord.
 *
 * INBOUND: messages arrive on the EXISTING public ingest route through an
 * EventSource whose provider is slack/telegram/discord (signature-verified
 * BEFORE anything here runs — verifySlack / verifyTelegram / verifyDiscord).
 * `normalizeMessageEvent` reduces the provider payload to a small DATA shape
 * (S1: text is event data, interpolated only where the promptTemplate
 * references it; the mapping evaluator enforces the interpolation caps).
 *
 *   slack    → Events API `event_callback` (message.channels / app_mention).
 *   telegram → webhook-mode `update` (message). NO long-poll daemon.
 *   discord  → interactions endpoint APPLICATION_COMMAND (type 2). Regular
 *              channel messages need a gateway websocket — out of scope for a
 *              webhook-style ingest; a slash command IS the Discord "message".
 *
 * OUTBOUND: `postPlatformMessage` posts a text (with optional Approve/Deny
 * buttons) through a BOT connection's token — Slack chat.postMessage (the
 * thread-capable extension of the slack_incoming path), Telegram sendMessage
 * (reply_to_message_id), Discord channel message with a Bot token. The Discord
 * bot-token path was chosen over the interaction-response webhook because
 * interaction webhooks expire after 15 minutes and a run can easily outlast
 * that. S2: bot tokens arrive as parameters (revealed from the SecretStore by
 * the server/harness caller); nothing here persists or logs them.
 *
 * CALLBACKS: Approve/Deny button clicks arrive on the SAME ingest route
 * (Slack interactivity form-POST / Telegram callback_query / Discord component
 * interaction, type 3), pass the SAME signature verification, and are parsed
 * by `parseApprovalCallback` into { decision, token } — they NEVER create
 * events.
 */

import type { FetchFn } from "./http-fetch.js";
import type { MessagePlatform, MessageTriggerConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Origin + normalized shapes
// ---------------------------------------------------------------------------

/** Where a message came from — the reply coordinates a message_reply
 *  destination / approval prompt posts back to. Stamped (as metadata) onto the
 *  created run's `input.event.origin`. */
export type MessageOrigin =
  | { platform: "slack"; channel: string; threadTs: string }
  | { platform: "telegram"; chatId: string; messageId?: number }
  | { platform: "discord"; channelId: string };

/** One normalized inbound message (payload is the S1 event DATA). */
export interface NormalizedMessageEvent {
  /** Fires as this event name ("message" / "app_mention" / "command"). */
  eventName: string;
  /** The S1 event payload handed to the mapping evaluator. */
  payload: Record<string, unknown>;
  origin: MessageOrigin;
  /** The channel/chat identity used for config.channelId filtering. */
  channelId: string;
  isDm: boolean;
  isMention: boolean;
}

// ---------------------------------------------------------------------------
// Inbound normalization
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function normalizeSlack(payload: Record<string, unknown>): NormalizedMessageEvent | null {
  if (payload["type"] !== "event_callback") return null;
  const ev = rec(payload["event"]);
  if (!ev) return null;
  const type = str(ev["type"]);
  if (type !== "message" && type !== "app_mention") return null;
  // Never fire on bot/self messages or message subtypes (edits, joins, …) —
  // the reply-bot's own posts must not re-trigger (loop guard).
  if (ev["bot_id"] !== undefined || ev["subtype"] !== undefined) return null;
  const channel = str(ev["channel"]);
  const ts = str(ev["ts"]);
  if (!channel || !ts) return null;
  const threadTs = str(ev["thread_ts"]) ?? ts;
  return {
    eventName: type,
    payload: {
      channel,
      threadTs,
      user: str(ev["user"]) ?? null,
      text: str(ev["text"]) ?? "",
      ts,
    },
    origin: { platform: "slack", channel, threadTs },
    channelId: channel,
    isDm: str(ev["channel_type"]) === "im",
    isMention: type === "app_mention",
  };
}

function normalizeTelegram(payload: Record<string, unknown>): NormalizedMessageEvent | null {
  const message = rec(payload["message"]);
  if (!message) return null; // callback_query / edits / channel posts → not a message fire
  const chat = rec(message["chat"]);
  const chatIdRaw = chat?.["id"];
  if (typeof chatIdRaw !== "number" && typeof chatIdRaw !== "string") return null;
  const chatId = String(chatIdRaw);
  const text = str(message["text"]);
  if (text === undefined) return null; // media-only updates are skipped
  const from = rec(message["from"]);
  if (from?.["is_bot"] === true) return null; // loop guard
  const fromLabel =
    str(from?.["username"]) ?? str(from?.["first_name"]) ?? String(from?.["id"] ?? "unknown");
  const messageId = typeof message["message_id"] === "number" ? message["message_id"] : undefined;
  const entities = Array.isArray(message["entities"]) ? message["entities"] : [];
  const isMention = entities.some((e) => rec(e)?.["type"] === "mention");
  return {
    eventName: "message",
    payload: { chatId, messageId: messageId ?? null, from: fromLabel, text },
    origin: { platform: "telegram", chatId, ...(messageId !== undefined ? { messageId } : {}) },
    channelId: chatId,
    isDm: str(chat?.["type"]) === "private",
    isMention,
  };
}

function normalizeDiscord(payload: Record<string, unknown>): NormalizedMessageEvent | null {
  if (payload["type"] !== 2) return null; // APPLICATION_COMMAND only
  const channelId = str(payload["channel_id"]);
  if (!channelId) return null;
  const data = rec(payload["data"]);
  const name = str(data?.["name"]) ?? "command";
  const options = Array.isArray(data?.["options"]) ? data["options"] : [];
  const args = options
    .map((o) => {
      const opt = rec(o);
      const v = opt?.["value"];
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : undefined;
    })
    .filter((v): v is string => v !== undefined);
  const member = rec(payload["member"]);
  const user = rec(member?.["user"]) ?? rec(payload["user"]);
  const guildId = str(payload["guild_id"]);
  return {
    eventName: "command",
    payload: {
      channelId,
      guildId: guildId ?? null,
      user: str(user?.["username"]) ?? str(user?.["id"]) ?? null,
      content: args.length > 0 ? `/${name} ${args.join(" ")}` : `/${name}`,
    },
    origin: { platform: "discord", channelId },
    channelId,
    isDm: guildId === undefined,
    isMention: true, // a slash command is an explicit invocation
  };
}

/**
 * Normalizes a provider payload into a message event, or null when the payload
 * is not a fireable message (handshakes, callbacks, bot/self posts, other
 * event types). The caller has ALREADY verified the provider signature.
 */
export function normalizeMessageEvent(
  platform: MessagePlatform,
  payload: unknown,
): NormalizedMessageEvent | null {
  const body = rec(payload);
  if (!body) return null;
  switch (platform) {
    case "slack":
      return normalizeSlack(body);
    case "telegram":
      return normalizeTelegram(body);
    case "discord":
      return normalizeDiscord(body);
    default:
      return null;
  }
}

/**
 * Does a normalized message match a message trigger's config? (Platform ↔
 * source pairing is the CALLER's job: the fan-out only presents messages from
 * the trigger's own config.sourceId, whose provider equals config.platform.)
 */
export function messageTriggerMatches(
  config: MessageTriggerConfig,
  message: NormalizedMessageEvent,
): boolean {
  if (
    config.channelId !== null &&
    config.channelId !== undefined &&
    config.channelId !== message.channelId
  ) {
    return false;
  }
  // Explicit provider-event filter wins when present.
  if (config.events !== undefined && config.events.length > 0) {
    return config.events.includes(message.eventName);
  }
  switch (config.scope) {
    case "mention":
      return message.isMention;
    case "dm":
      return message.isDm;
    case "channel":
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Approval callbacks (Approve/Deny button clicks on the ingest route)
// ---------------------------------------------------------------------------

/** Prefix of the button callback data: `akauto:<approve|deny>:<token>`. */
export const APPROVAL_CALLBACK_PREFIX = "akauto";

/** One parsed Approve/Deny button click. */
export interface ApprovalCallback {
  decision: "approve" | "deny";
  /** The one-time plaintext approval token (verified against the stored hash). */
  token: string;
}

/** Builds the opaque button callback data for a decision. */
export function buildApprovalCallbackData(decision: "approve" | "deny", token: string): string {
  return `${APPROVAL_CALLBACK_PREFIX}:${decision}:${token}`;
}

/** Parses `akauto:<approve|deny>:<token>` callback data, or null. */
export function parseApprovalCallbackData(data: unknown): ApprovalCallback | null {
  if (typeof data !== "string") return null;
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== APPROVAL_CALLBACK_PREFIX) return null;
  const [, decision, token] = parts;
  if ((decision !== "approve" && decision !== "deny") || !token || token.length === 0) return null;
  return { decision, token };
}

/**
 * Parses a Slack INTERACTIVITY request body (application/x-www-form-urlencoded
 * with a `payload=<json>` field) into the interaction object, or null. Slack
 * signs the RAW form body, so signature verification happens on the raw text
 * BEFORE this parse.
 */
export function parseSlackInteractionPayload(rawBody: string): Record<string, unknown> | null {
  try {
    const params = new URLSearchParams(rawBody);
    const payload = params.get("payload");
    if (payload === null) return null;
    const parsed: unknown = JSON.parse(payload);
    return rec(parsed) ?? null;
  } catch {
    return null;
  }
}

/**
 * Extracts an Approve/Deny callback from a verified provider payload:
 *   slack    → block_actions payload, actions[0].value
 *   telegram → update.callback_query.data
 *   discord  → interaction type 3 (MESSAGE_COMPONENT), data.custom_id
 * Returns null when the payload is not an approval callback.
 */
export function parseApprovalCallback(
  platform: MessagePlatform,
  payload: unknown,
): ApprovalCallback | null {
  const body = rec(payload);
  if (!body) return null;
  switch (platform) {
    case "slack": {
      if (body["type"] !== "block_actions") return null;
      const actions = Array.isArray(body["actions"]) ? body["actions"] : [];
      for (const action of actions) {
        const parsed = parseApprovalCallbackData(rec(action)?.["value"]);
        if (parsed !== null) return parsed;
      }
      return null;
    }
    case "telegram": {
      const cq = rec(body["callback_query"]);
      return cq ? parseApprovalCallbackData(cq["data"]) : null;
    }
    case "discord": {
      if (body["type"] !== 3) return null;
      return parseApprovalCallbackData(rec(body["data"])?.["custom_id"]);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Outbound platform posts (replies + approval prompts)
// ---------------------------------------------------------------------------

/** Post timeout (ms) — mirrors the destination webhook timeout. */
export const PLATFORM_POST_TIMEOUT_MS = 10_000;

/** Max characters of a posted message body (providers cap lower; we truncate
 *  first so a giant run summary can never bounce the post). */
export const PLATFORM_POST_MAX_CHARS = 1900;

/** An outbound post target: a message origin, or a connection-config default
 *  channel/chat (used for approval prompts on non-message triggers). */
export type PlatformPostTarget = MessageOrigin;

export interface PlatformPostArgs {
  target: PlatformPostTarget;
  /** Bot token (SecretStore-revealed by the caller — S2; never logged). */
  botToken: string;
  text: string;
  /** When present, Approve/Deny buttons are attached (block kit / inline
   *  keyboard / components) carrying the callback data verbatim. */
  approval?: { approveData: string; denyData: string };
  fetchImpl: FetchFn;
}

export interface PlatformPostResult {
  status: "delivered" | "failed";
  error?: string;
}

function truncateText(text: string): string {
  return text.length <= PLATFORM_POST_MAX_CHARS
    ? text
    : `${text.slice(0, PLATFORM_POST_MAX_CHARS)}\n…[truncated]`;
}

/** Resolves a connection-config default target for approval prompts when no
 *  message origin exists (e.g. requireApproval on an email_in trigger). */
export function defaultTargetFromConnectionConfig(
  platform: MessagePlatform,
  config: Record<string, unknown>,
): PlatformPostTarget | undefined {
  switch (platform) {
    case "slack": {
      const channel = str(config["channelId"]) ?? str(config["channel"]);
      return channel ? { platform: "slack", channel, threadTs: "" } : undefined;
    }
    case "telegram": {
      const chatId = str(config["chatId"]);
      return chatId ? { platform: "telegram", chatId } : undefined;
    }
    case "discord": {
      const channelId = str(config["channelId"]);
      return channelId ? { platform: "discord", channelId } : undefined;
    }
    default:
      return undefined;
  }
}

async function postJson(
  fetchImpl: FetchFn,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<PlatformPostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLATFORM_POST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      return { status: "failed", error: `Platform responded with HTTP ${res.status}.` };
    }
    // Slack returns HTTP 200 with { ok: false, error } on API failures.
    try {
      const parsed: unknown = JSON.parse(await res.text());
      const obj = rec(parsed);
      if (obj !== undefined && obj["ok"] === false) {
        const detail = str(obj["error"]) ?? "unknown_error";
        return { status: "failed", error: `Platform API error: ${detail}.` };
      }
    } catch {
      /* non-JSON body on a 2xx = success */
    }
    return { status: "delivered" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Posts one message (optionally with Approve/Deny buttons) through the
 * platform's bot API. Provider hosts are FIXED (api.slack.com /
 * api.telegram.org / discord.com) — no user-controlled URL, so no SSRF
 * surface. NEVER throws; the bot token is never included in any error detail.
 */
export async function postPlatformMessage(args: PlatformPostArgs): Promise<PlatformPostResult> {
  const { target, botToken, fetchImpl, approval } = args;
  const text = truncateText(args.text);
  switch (target.platform) {
    case "slack": {
      const body: Record<string, unknown> = {
        channel: target.channel,
        text,
        ...(target.threadTs.length > 0 ? { thread_ts: target.threadTs } : {}),
      };
      if (approval !== undefined) {
        body["blocks"] = [
          { type: "section", text: { type: "mrkdwn", text } },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                style: "primary",
                text: { type: "plain_text", text: "Approve" },
                action_id: "akauto_approve",
                value: approval.approveData,
              },
              {
                type: "button",
                style: "danger",
                text: { type: "plain_text", text: "Deny" },
                action_id: "akauto_deny",
                value: approval.denyData,
              },
            ],
          },
        ];
      }
      return postJson(
        fetchImpl,
        "https://slack.com/api/chat.postMessage",
        { authorization: `Bearer ${botToken}` },
        body,
      );
    }
    case "telegram": {
      const body: Record<string, unknown> = {
        chat_id: target.chatId,
        text,
        ...(target.messageId !== undefined ? { reply_to_message_id: target.messageId } : {}),
      };
      if (approval !== undefined) {
        body["reply_markup"] = {
          inline_keyboard: [
            [
              { text: "Approve", callback_data: approval.approveData },
              { text: "Deny", callback_data: approval.denyData },
            ],
          ],
        };
      }
      return postJson(
        fetchImpl,
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {},
        body,
      );
    }
    case "discord": {
      const body: Record<string, unknown> = { content: text };
      if (approval !== undefined) {
        body["components"] = [
          {
            type: 1, // action row
            components: [
              { type: 2, style: 3, label: "Approve", custom_id: approval.approveData },
              { type: 2, style: 4, label: "Deny", custom_id: approval.denyData },
            ],
          },
        ];
      }
      return postJson(
        fetchImpl,
        `https://discord.com/api/v10/channels/${encodeURIComponent(target.channelId)}/messages`,
        { authorization: `Bot ${botToken}` },
        body,
      );
    }
    default:
      return { status: "failed", error: "Unknown platform." };
  }
}

/**
 * Re-derives a MessageOrigin from a NORMALIZED message payload (the shape
 * `normalizeMessageEvent` produced — used when a held approval re-presents a
 * stored event and the origin must be reconstructed). Undefined when the
 * payload does not carry the platform's coordinates.
 */
export function originFromMessagePayload(
  platform: MessagePlatform,
  payload: unknown,
): MessageOrigin | undefined {
  const body = rec(payload);
  if (!body) return undefined;
  switch (platform) {
    case "slack": {
      const channel = str(body["channel"]);
      if (!channel) return undefined;
      return { platform: "slack", channel, threadTs: str(body["threadTs"]) ?? "" };
    }
    case "telegram": {
      const chatId = str(body["chatId"]) ?? (typeof body["chatId"] === "number" ? String(body["chatId"]) : undefined);
      if (!chatId) return undefined;
      const messageId = typeof body["messageId"] === "number" ? body["messageId"] : undefined;
      return { platform: "telegram", chatId, ...(messageId !== undefined ? { messageId } : {}) };
    }
    case "discord": {
      const channelId = str(body["channelId"]);
      return channelId ? { platform: "discord", channelId } : undefined;
    }
    default:
      return undefined;
  }
}

/** The bot connection type expected for a platform. */
export function botConnectionTypeFor(platform: MessagePlatform): string {
  return `${platform}_bot`;
}

/** The platform of a bot connection type, or undefined. */
export function platformOfBotConnectionType(type: string): MessagePlatform | undefined {
  if (type === "slack_bot") return "slack";
  if (type === "telegram_bot") return "telegram";
  if (type === "discord_bot") return "discord";
  return undefined;
}
