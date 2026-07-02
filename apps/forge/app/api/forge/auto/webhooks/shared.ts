// Shared response shaping for the webhook routes (cookie + bearer).
//
// CRITICAL: the secretHash is NEVER exposed to any client. List/get responses
// strip it; the plaintext secret is returned ONLY once, in the create response.
import type { AutoWebhook } from "@agentkitforge/auto-core";
import type { CreatedWebhook } from "@/server/core/auto";
import { webhookIngestUrl } from "@/server/core/auto";

/** A webhook record safe to return to a client (secretHash removed; ingest URL
 *  added for convenience). */
export type PublicWebhook = Omit<AutoWebhook, "secretHash"> & { ingestUrl: string };

/** Strip the secretHash and attach the ingest URL. */
export function toPublicWebhook(w: AutoWebhook): PublicWebhook {
  const { secretHash: _secretHash, ...rest } = w;
  return { ...rest, ingestUrl: webhookIngestUrl(w.id) };
}

export function webhookListResponse(webhooks: AutoWebhook[]): PublicWebhook[] {
  return webhooks.map(toPublicWebhook);
}

/** The one-time create response: the public webhook PLUS the plaintext secret
 *  (shown ONCE — never retrievable again) + the ingest URL. */
export function createWebhookResponse(created: CreatedWebhook): PublicWebhook & { secret: string } {
  return {
    ...toPublicWebhook(created.webhook),
    ingestUrl: created.ingestUrl,
    secret: created.secret
  };
}
