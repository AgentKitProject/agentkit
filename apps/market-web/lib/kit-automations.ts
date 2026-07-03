import {
  buildAutomationTemplateLink,
  type AutomationTemplateTrigger,
  type AutomationTemplateTriggerType
} from "./automation-template-link.ts";

/**
 * Public, display-safe summary of a kit's suggested automation, as rendered
 * on the kit detail page. Normalized defensively from the kit-detail API
 * payload: only the known suggestion fields are kept (never approvals,
 * budgets, destinations, or connections — those are completed by the human
 * in the Auto wizard).
 */
export type KitAutomationSummary = {
  name: string;
  description?: string;
  trigger: {
    type: AutomationTemplateTriggerType;
    config?: {
      cron?: string;
      timezone?: string;
      eventName?: string;
    };
  };
  promptTemplate: string;
};

const MAX_AUTOMATIONS = 10;

/**
 * Normalizes an unknown `automations` value from the kit-detail API payload
 * into display-safe summaries. Malformed entries are dropped, unknown keys
 * are never carried through, and the list is capped at 10 (mirrors the
 * @agentkitforge/core manifest constraints).
 */
export function normalizeKitAutomations(value: unknown): KitAutomationSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: KitAutomationSummary[] = [];
  for (const entry of value) {
    if (normalized.length >= MAX_AUTOMATIONS) {
      break;
    }

    const automation = normalizeEntry(entry);
    if (automation) {
      normalized.push(automation);
    }
  }

  return normalized;
}

function normalizeEntry(entry: unknown): KitAutomationSummary | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }

  const name = boundedString(entry.name, 80);
  const promptTemplate = boundedString(entry.promptTemplate, 4000);
  const trigger = normalizeTrigger(entry.trigger);
  if (!name || !promptTemplate || !trigger) {
    return undefined;
  }

  const description = boundedString(entry.description, 300);
  return {
    name,
    ...(description ? { description } : {}),
    trigger,
    promptTemplate
  };
}

function normalizeTrigger(value: unknown): KitAutomationSummary["trigger"] | undefined {
  if (!isRecord(value) || (value.type !== "schedule" && value.type !== "event")) {
    return undefined;
  }

  const rawConfig = isRecord(value.config) ? value.config : {};
  const config =
    value.type === "schedule"
      ? {
          cron: boundedString(rawConfig.cron, 120),
          timezone: boundedString(rawConfig.timezone, 64)
        }
      : { eventName: boundedString(rawConfig.eventName, 120) };
  const definedConfig = Object.fromEntries(
    Object.entries(config).filter(([, entryValue]) => entryValue !== undefined)
  );

  return {
    type: value.type,
    ...(Object.keys(definedConfig).length > 0 ? { config: definedConfig } : {})
  };
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Plain-language trigger summary for the Automations card, e.g.
 * "Daily at 9:00", "Weekly on Monday at 17:30", or "When an event arrives".
 */
export function describeAutomationTrigger(trigger: KitAutomationSummary["trigger"]): string {
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

export type KitAutomationCardItem = {
  name: string;
  description?: string;
  triggerLabel: string;
  /** Undefined when no Auto app URL is configured (e.g. self-host without Auto). */
  enableHref?: string;
};

/**
 * Render model for the kit-detail Automations card. Each item carries the
 * plain-language trigger summary and the prefilled Auto-wizard deep link
 * (`?template=<base64url(JSON)>`), built with the contracts OBJECT kitRef
 * ({source:"market", marketKitId, slug}) — the Auto wizard's decoder rejects
 * string kitRefs and invalidates the whole template on a malformed one. The
 * deep link requires kitId; without it entries render link-less.
 */
export function buildKitAutomationsCardModel({
  automations,
  slug,
  kitId,
  autoBaseUrl
}: {
  automations: KitAutomationSummary[];
  slug: string;
  kitId?: string;
  autoBaseUrl?: string;
}): KitAutomationCardItem[] {
  return automations.map((automation) => ({
    name: automation.name,
    ...(automation.description ? { description: automation.description } : {}),
    triggerLabel: describeAutomationTrigger(automation.trigger),
    ...(autoBaseUrl && kitId
      ? {
          enableHref: buildAutomationTemplateLink({
            autoBaseUrl,
            template: {
              name: automation.name,
              trigger: automation.trigger as AutomationTemplateTrigger,
              mapping: { promptTemplate: automation.promptTemplate },
              kitRef: { source: "market", marketKitId: kitId, slug }
            }
          })
        }
      : {})
  }));
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
