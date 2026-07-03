// Pure builders + copy for the wizard's MESSAGING trigger kind (kind
// "message" — Slack / Telegram / Discord). Kept UI-free so they are
// unit-testable in the node vitest environment (the TriggerWizard JSX imports
// these), mirroring watch-connect.ts / trigger-config.ts.
//
// A messaging automation is the most complex wizard flow — it stitches together
// FOUR pieces the contracts already model:
//   1. an inbound EventSource (kind "provider", provider === platform) that
//      receives the signature-verified provider webhook (buildMessageSource...);
//   2. an outbound BOT connection (slack_bot/telegram_bot/discord_bot) whose
//      SecretStore secret is the BOT TOKEN — used for reply-to-thread and the
//      pre-run Approve/Deny prompt (buildBotConnectionRequest);
//   3. the message trigger config { platform, sourceId, connectionId?, scope,
//      channelId?, events? } (buildMessageConfig);
//   4. a message_reply destination { type, connectionId, replyToOrigin } that
//      posts the run summary back to the originating channel/thread/chat
//      (buildMessageReplyDestination).
//
// S2 stays intact everywhere: the provider SIGNING SECRET (event-source) and the
// BOT TOKEN (connection) are BOTH write-only credential material moved
// server-side straight into their encrypted stores — neither ever lands in a
// contract `config` (the connection config is refined to reject secret-looking
// keys) or any response.

import type {
  CreateConnectionRequest,
  CreateEventSourceRequest,
  Destination,
  MessagePlatform,
  MessageTriggerConfig
} from "@agentkitforge/contracts";

/** The three messaging platforms, in display order (drives the picker). A
 *  platform's provider name and bot-connection prefix are BOTH the platform
 *  string (slack/telegram/discord ↔ slack/telegram/discord provider ↔
 *  slack_bot/telegram_bot/discord_bot connection). */
export const MESSAGE_PLATFORMS: {
  platform: MessagePlatform;
  label: string;
  icon: string;
  /** Per-platform label for the inbound event-source signing secret — the field
   *  MEANS a different thing on each platform (see event-ingest.ts auth). */
  signingSecretLabel: string;
  /** Placeholder shown in the signing-secret input. */
  signingSecretPlaceholder: string;
  /** Short note under the signing-secret input clarifying where to find it. */
  signingSecretHint: string;
  /** Per-platform label for the bot-token input (the outbound connection). */
  botTokenLabel: string;
  /** Placeholder shown in the bot-token input. */
  botTokenPlaceholder: string;
}[] = [
  {
    platform: "slack",
    label: "Slack",
    icon: "💬",
    signingSecretLabel: "Slack app Signing Secret",
    signingSecretPlaceholder: "paste your Slack app Signing Secret",
    signingSecretHint:
      "Slack app settings → Basic Information → App Credentials → Signing Secret. We verify the X-Slack-Signature on every request.",
    botTokenLabel: "Slack Bot User OAuth Token",
    botTokenPlaceholder: "xoxb-…"
  },
  {
    platform: "telegram",
    label: "Telegram",
    icon: "✈️",
    signingSecretLabel: "Webhook secret token",
    signingSecretPlaceholder: "a secret you choose (10–256 chars)",
    signingSecretHint:
      "You choose this value and pass it as secret_token when you call setWebhook. Telegram echoes it back in the X-Telegram-Bot-Api-Secret-Token header, which we verify on every update.",
    botTokenLabel: "Telegram Bot Token",
    botTokenPlaceholder: "123456:ABC-DEF…"
  },
  {
    platform: "discord",
    label: "Discord",
    icon: "🎮",
    signingSecretLabel: "Discord application Public Key",
    signingSecretPlaceholder: "the application Public Key (hex)",
    signingSecretHint:
      "Discord Developer Portal → your application → General Information → Public Key. We verify the ed25519 interaction signature on every request.",
    botTokenLabel: "Discord Bot Token",
    botTokenPlaceholder: "the bot token from Bot → Reset Token"
  }
];

/** The messaging platform descriptor, or undefined. */
export function messagePlatformInfo(platform: string) {
  return MESSAGE_PLATFORMS.find((p) => p.platform === platform);
}

// ---------------------------------------------------------------------------
// Inbound event source (kind "provider", provider === platform)
// ---------------------------------------------------------------------------

export interface MessageSourceFields {
  name: string;
  platform: MessagePlatform;
  /** The platform's signing secret (Slack signing secret / Telegram webhook
   *  secret_token / Discord application Public Key). Write-only. */
  signingSecret: string;
}

/**
 * Builds the POST /api/auto/event-sources body for an inline inbound source: a
 * PROVIDER source whose `provider` equals the platform, carrying the write-only
 * `signingSecret`. A provider source with no signing secret cannot verify
 * inbound requests, so the wizard requires one (whenReady) — but the builder
 * only omits an EMPTY string so the contract's `.min(1)` never rejects "".
 */
export function buildMessageSourceRequest(
  fields: MessageSourceFields
): CreateEventSourceRequest & { signingSecret?: string } {
  const secret = fields.signingSecret.trim();
  return {
    name: fields.name.trim() || `${platformLabel(fields.platform)} messages`,
    kind: "provider",
    provider: fields.platform,
    ...(secret ? { signingSecret: secret } : {})
  };
}

// ---------------------------------------------------------------------------
// Outbound bot connection (slack_bot / telegram_bot / discord_bot)
// ---------------------------------------------------------------------------

/** The bot connection type for a platform (matches auto-core botConnectionTypeFor). */
export function botConnectionType(platform: MessagePlatform): "slack_bot" | "telegram_bot" | "discord_bot" {
  return `${platform}_bot`;
}

/** The platform of a bot connection type, or undefined (for filtering the
 *  existing-connection picker to the chosen platform). */
export function platformOfBotConnectionType(type: string): MessagePlatform | undefined {
  if (type === "slack_bot") return "slack";
  if (type === "telegram_bot") return "telegram";
  if (type === "discord_bot") return "discord";
  return undefined;
}

/** True when a connection type is a messaging bot connection. */
export function isBotConnectionType(type: string): boolean {
  return platformOfBotConnectionType(type) !== undefined;
}

export interface BotConnectionFields {
  name: string;
  platform: MessagePlatform;
  /** The bot token (Slack xoxb / Telegram bot token / Discord bot token).
   *  Write-only — rides in the connection's `secret`, never in `config`. */
  botToken: string;
  /** Optional default channel/chat id, stored in the non-secret config. Used as
   *  the fallback target for Approve/Deny prompts on non-message triggers; for a
   *  message trigger the reply always follows the originating message's origin. */
  defaultChannelId?: string;
}

/**
 * Builds the POST /api/auto/connections body for an inline bot connection. The
 * BOT TOKEN rides in the write-only `secret` (→ SecretStore); the non-secret
 * config carries only an OPTIONAL default channel id (never a secret — the
 * contract refines config to reject secret-looking keys). Mirrors
 * buildS3ConnectionRequest.
 */
export function buildBotConnectionRequest(fields: BotConnectionFields): CreateConnectionRequest {
  const channelId = fields.defaultChannelId?.trim();
  const config: Record<string, unknown> = {};
  if (channelId) config.channelId = channelId;
  return {
    type: botConnectionType(fields.platform),
    name: fields.name.trim() || `${platformLabel(fields.platform)} bot`,
    config,
    secret: fields.botToken.trim(),
    ownerType: "user"
  };
}

/** A local validation error string, or null when the bot-connection form is
 *  complete (name + token). */
export function validateBotConnectionFields(fields: BotConnectionFields): string | null {
  if (!fields.name.trim()) return "Name this bot connection.";
  if (!fields.botToken.trim()) return "Paste the bot token.";
  return null;
}

// ---------------------------------------------------------------------------
// The message trigger config
// ---------------------------------------------------------------------------

export type MessageScope = "mention" | "dm" | "channel";

export interface MessageConfigFields {
  platform: MessagePlatform;
  /** The inbound EventSource id (provider === platform). */
  sourceId: string;
  /** The outbound bot connection id (null/absent when neither reply nor
   *  approval is enabled). */
  connectionId?: string | null;
  scope: MessageScope;
  /** Restrict to one channel/chat id; blank = all. */
  channelId?: string;
  /** Optional advanced provider event-type filter (max 10). */
  events?: string[];
}

/**
 * The messageTriggerConfig object (contract shape) from the wizard fields.
 * connectionId/channelId are omitted when blank (null/absent per the contract);
 * events are trimmed, de-duped, and capped at 10 (empty → omitted so the scope's
 * default set applies).
 */
export function buildMessageConfig(fields: MessageConfigFields): MessageTriggerConfig {
  const connectionId = fields.connectionId?.trim();
  const channelId = fields.channelId?.trim();
  const events = normalizeEvents(fields.events ?? []);
  return {
    platform: fields.platform,
    sourceId: fields.sourceId,
    ...(connectionId ? { connectionId } : {}),
    scope: fields.scope,
    ...(channelId ? { channelId } : {}),
    ...(events.length > 0 ? { events } : {})
  };
}

/** Trim/de-dupe/cap an event-type filter list to the contract max (10). */
export function normalizeEvents(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const e = entry.trim();
    if (e.length === 0 || e.length > 64 || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
    if (out.length >= 10) break;
  }
  return out;
}

/** Split the free-text advanced event-filter box (comma/newline/space) into
 *  candidate event names. */
export function parseEventsInput(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

// ---------------------------------------------------------------------------
// The message_reply destination
// ---------------------------------------------------------------------------

/**
 * Builds a `message_reply` destination that posts the run summary back to the
 * originating channel/thread/chat through the bot connection. `replyToOrigin`
 * is always `true` today (the only meaningful value).
 */
export function buildMessageReplyDestination(connectionId: string): Destination {
  return { type: "message_reply", connectionId, replyToOrigin: true };
}

/**
 * The trigger's destinations, INSERTING the reply destination first when reply
 * is enabled AND a bot connection is set (and not already present). Normal
 * destinations follow. Idempotent: never adds a second message_reply.
 */
export function withReplyDestination(
  destinations: Destination[],
  replyEnabled: boolean,
  connectionId: string | null | undefined
): Destination[] {
  const conn = connectionId?.trim();
  const rest = destinations.filter((d) => d.type !== "message_reply");
  if (!replyEnabled || !conn) return rest;
  return [buildMessageReplyDestination(conn), ...rest];
}

// ---------------------------------------------------------------------------
// whenReady gating (pure — drives the wizard's WHEN-step validity)
// ---------------------------------------------------------------------------

/**
 * Whether the messaging WHEN step is ready to advance. A source is always
 * required; a bot connection is required only when reply OR approval is on
 * (both need the bot token). Platform is implicit in the source (kept for a
 * clearer failure message upstream).
 */
export function messageWhenReady(fields: {
  platform: MessagePlatform | null;
  sourceId: string;
  connectionId: string | null | undefined;
  replyEnabled: boolean;
  requireApproval: boolean;
}): boolean {
  if (!fields.platform) return false;
  if (fields.sourceId.trim().length === 0) return false;
  const needsBot = fields.replyEnabled || fields.requireApproval;
  if (needsBot && !fields.connectionId?.trim()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Per-platform inbound setup instructions (copy-paste, real ingest URL)
// ---------------------------------------------------------------------------

function platformLabel(platform: MessagePlatform): string {
  return messagePlatformInfo(platform)?.label ?? platform;
}

/**
 * Copy-paste inbound-setup steps for a platform, with the source's real ingest
 * URL substituted. Mirrors presets.ts's instruction style (numbered lines in
 * the UI). These describe pointing the provider's webhook/interactions endpoint
 * at our ingest URL and where the signing secret comes from; the handshakes
 * (Slack url_verification / Discord PING) are handled automatically server-side.
 */
export function messageSourceInstructions(platform: MessagePlatform, ingestUrl: string): string[] {
  switch (platform) {
    case "slack":
      return [
        "In your Slack app settings → Event Subscriptions, turn Enable Events on.",
        `Set the Request URL to: ${ingestUrl}`,
        "Slack sends a one-time url_verification challenge — we answer it automatically, so the URL turns green on its own.",
        'Under "Subscribe to bot events" add message.channels (any channel message) and/or app_mention (only when the bot is @-mentioned), then reinstall the app.'
      ];
    case "telegram":
      return [
        "Register the webhook with Telegram's Bot API, pointing it at the ingest URL and setting the secret_token to the value you entered above:",
        `curl -X POST 'https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook' -H 'content-type: application/json' -d '{"url":"${ingestUrl}","secret_token":"<THE_SECRET_TOKEN_ABOVE>"}'`,
        "Telegram echoes secret_token back in the X-Telegram-Bot-Api-Secret-Token header on every update — we verify it (constant-time) against the value you saved. Message the bot to test.",
        "Note: Telegram delivers via webhook only here (no long-poll); make sure no other webhook is registered for the same bot."
      ];
    case "discord":
      return [
        "In the Discord Developer Portal → your application → General Information, set the Interactions Endpoint URL to:",
        `${ingestUrl}`,
        "Discord sends a PING to validate the endpoint — we answer it automatically (and verify the ed25519 signature using the Public Key above), so it saves without extra steps.",
        "Add a slash command to your application; invoking it fires this automation (regular channel messages need a gateway bot, which a webhook endpoint can't receive)."
      ];
    default:
      return [];
  }
}
