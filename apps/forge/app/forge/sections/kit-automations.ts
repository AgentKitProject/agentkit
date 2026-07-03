// Pure helpers for the Forge "Automations" card: turning a kit's suggested
// `automations:` manifest entries (surfaced by @agentkitforge/core
// getKitAutomations via the summary API) into display items, and building the
// AgentKitAuto wizard deep link. Extracted so the logic is unit-testable
// without a DOM/React (mirrors market-kit-ref.ts in this folder).
//
// Forge LINKS OUT to Auto — it never embeds it (maintainer decision). The link
// is the exact contract Market ships from its kit-detail page:
//
//   `${autoBaseUrl}/?template=<base64url(JSON.stringify(template))>`
//
// The payload carries only name + trigger suggestion + promptTemplate + kitRef.
// It NEVER carries approvals, budgets, destinations, or connections — the
// human reviews the prompt and completes those in the Auto wizard.
//
// kitRef decision: Auto's wizard validates `kitRef` against the contracts
// `kitRefSchema` OBJECT form and resolves a local kit by matching
// `kitRef.localKitId` against its kit selector (auto-web TriggerWizard
// kitRefToSelection). Auto's kit selector is fed by auto-web `GET /api/kits`,
// which lists the SAME per-user kit store Forge writes to — so every kit shown
// in Forge's My Kits is resolvable by Auto under its Forge kit id. We therefore
// always send `{ source: "local", localKitId: <kitId> }`. (Market's own card
// covers the `market:<slug>` case for catalog kits; Forge does not need it.
// If Auto ever stopped resolving local kits, the fallback would be to render
// entries without the enable link — see buildForgeAutomationsCardModel.)

import type { KitRef } from "@agentkitforge/contracts";

export type ForgeAutomationTriggerType = "schedule" | "event";

/** A kit's suggested automation as returned by /api/kits/:kitId/summary
 *  (shape of @agentkitforge/core AgentKitAutomation; schema-validated
 *  server-side, so entries arriving here are well-formed). */
export type ForgeKitAutomation = {
  name: string;
  description?: string;
  trigger: {
    type: ForgeAutomationTriggerType;
    config?: {
      cron?: string;
      timezone?: string;
      eventName?: string;
    };
  };
  promptTemplate: string;
};

/** The `?template=` payload — the same wire shape Market encodes and the Auto
 *  wizard decodes (auto-web lib/automations/template-link.ts). */
export type ForgeAutomationTemplate = {
  name: string;
  trigger: { type: ForgeAutomationTriggerType; config?: Record<string, unknown> };
  mapping: { promptTemplate: string };
  kitRef: KitRef;
};

/**
 * Encodes a template as base64url(JSON) — byte-for-byte identical to Market's
 * `Buffer.from(JSON.stringify(t), "utf8").toString("base64url")`, but browser
 * (btoa) and Node (Buffer) safe because Forge sections are client components.
 */
export function encodeAutomationTemplateParam(template: ForgeAutomationTemplate): string {
  const json = JSON.stringify(template);
  let b64: string;
  if (typeof btoa === "function") {
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    b64 = btoa(bin);
  } else {
    b64 = Buffer.from(json, "utf8").toString("base64");
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Builds the Auto wizard deep link: `${autoBaseUrl}/?template=<base64url(JSON)>`. */
export function buildAutomationTemplateLink({
  autoBaseUrl,
  template
}: {
  autoBaseUrl: string;
  template: ForgeAutomationTemplate;
}): string {
  const base = autoBaseUrl.replace(/\/+$/, "");
  return `${base}/?template=${encodeAutomationTemplateParam(template)}`;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Plain-language trigger summary, e.g. "Daily at 9:00", "Weekly on Monday at
 * 17:30", or `When "invoice.received" arrives`. Same wording as Market's card.
 */
export function describeAutomationTrigger(trigger: ForgeKitAutomation["trigger"]): string {
  if (trigger.type === "event") {
    const eventName = trigger.config?.eventName;
    return eventName ? `When "${eventName}" arrives` : "When an event arrives";
  }

  const cron = trigger.config?.cron;
  const timezone = trigger.config?.timezone;
  const base = cron ? describeCron(cron) : "On a schedule";
  return timezone ? `${base} (${timezone})` : base;
}

function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const time = formatTime(hour, minute);
    if (time && dayOfMonth === "*" && month === "*") {
      if (dayOfWeek === "*") {
        return `Daily at ${time}`;
      }
      const weekday = WEEKDAY_NAMES[Number(dayOfWeek) === 7 ? 0 : Number(dayOfWeek)];
      if (/^[0-7]$/.test(dayOfWeek) && weekday) {
        return `Weekly on ${weekday} at ${time}`;
      }
    }
  }
  return `On a schedule (${cron})`;
}

function formatTime(hour: string, minute: string): string | undefined {
  if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute)) {
    return undefined;
  }
  const hours = Number(hour);
  const minutes = Number(minute);
  if (hours > 23 || minutes > 59) {
    return undefined;
  }
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

const PROMPT_PREVIEW_MAX = 160;

export type ForgeAutomationCardItem = {
  name: string;
  description?: string;
  triggerLabel: string;
  /** First ~160 chars of the prompt the human will review in the wizard. */
  promptPreview: string;
  /** Undefined when no Auto app URL is configured (e.g. self-host without Auto). */
  enableHref?: string;
};

/**
 * Render model for the kit editor's Automations card. Each item carries the
 * plain-language trigger summary, a prompt preview, and the prefilled Auto
 * wizard deep link built with kitRef `{ source: "local", localKitId: kitId }`
 * (see the header comment for why the local object form is always resolvable).
 */
export function buildForgeAutomationsCardModel({
  automations,
  kitId,
  autoBaseUrl
}: {
  automations: ForgeKitAutomation[];
  kitId: string;
  autoBaseUrl?: string;
}): ForgeAutomationCardItem[] {
  return automations.map((automation) => ({
    name: automation.name,
    ...(automation.description ? { description: automation.description } : {}),
    triggerLabel: describeAutomationTrigger(automation.trigger),
    promptPreview:
      automation.promptTemplate.length > PROMPT_PREVIEW_MAX
        ? `${automation.promptTemplate.slice(0, PROMPT_PREVIEW_MAX)}…`
        : automation.promptTemplate,
    ...(autoBaseUrl
      ? {
          enableHref: buildAutomationTemplateLink({
            autoBaseUrl,
            template: {
              name: automation.name,
              trigger: automation.trigger,
              mapping: { promptTemplate: automation.promptTemplate },
              kitRef: { source: "local", localKitId: kitId }
            }
          })
        }
      : {})
  }));
}
