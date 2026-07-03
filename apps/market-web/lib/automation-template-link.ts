/**
 * URL param contract between Market kit pages and the AgentKitAuto wizard.
 *
 * "Enable in Auto" deep-links into the Auto wizard prefilled from a kit's
 * suggested automation:
 *
 *   `${autoBaseUrl}/?template=<base64url(JSON.stringify(template))>`
 *
 * The template payload is intentionally minimal — name, trigger suggestion,
 * the prompt template the human reviews, and the kit reference. It NEVER
 * carries approvals, budgets, destinations, or connections; the human
 * completes those in the wizard. The Auto wizard consumes this exact shape.
 */

export type AutomationTemplateTriggerType = "schedule" | "event";

export type AutomationTemplateTrigger = {
  type: AutomationTemplateTriggerType;
  /** Suggested trigger prefills only (e.g. cron/timezone or eventName). */
  config?: Record<string, unknown>;
};

export type AutomationTemplate = {
  name: string;
  trigger: AutomationTemplateTrigger;
  mapping: {
    /** The instruction source the user reviews in the wizard before enabling. */
    promptTemplate: string;
  };
  /**
   * Kit reference in the contracts OBJECT form (`kitRefSchema`): the Auto
   * wizard's decoder validates against that schema and a malformed kitRef
   * invalidates the WHOLE template. Market kits must carry `marketKitId`
   * (schema-required) plus `slug` (the wizard's selector matches entitled
   * kits by slug). The old `"market:<slug>"` STRING form is rejected by the
   * decoder — never emit it.
   */
  kitRef: { source: "market"; marketKitId: string; slug: string };
};

/**
 * Builds the Auto wizard deep link: `${autoBaseUrl}/?template=<base64url(JSON)>`.
 * base64url output contains no `+`, `/`, or `=` so the value is URL-safe as-is.
 */
export function buildAutomationTemplateLink({
  autoBaseUrl,
  template
}: {
  autoBaseUrl: string;
  template: AutomationTemplate;
}): string {
  const base = autoBaseUrl.replace(/\/+$/, "");
  return `${base}/?template=${encodeAutomationTemplateParam(template)}`;
}

/** Encodes a template as base64url(JSON). Exposed for tests and tooling. */
export function encodeAutomationTemplateParam(template: AutomationTemplate): string {
  return Buffer.from(JSON.stringify(template), "utf8").toString("base64url");
}

/**
 * Decodes a `template` query-param value back into an AutomationTemplate.
 * This is the wizard-side half of the contract; kept here so the round-trip
 * is tested against the exact encoder Market ships. Throws on malformed input.
 */
export function decodeAutomationTemplateParam(value: string): AutomationTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("The automation template parameter is not valid base64url JSON.");
  }

  if (!isRecord(parsed)) {
    throw new Error("The automation template must be a JSON object.");
  }

  const trigger = parsed.trigger;
  const mapping = parsed.mapping;
  if (
    typeof parsed.name !== "string" ||
    parsed.name.length === 0 ||
    !isMarketKitRef(parsed.kitRef) ||
    !isRecord(trigger) ||
    (trigger.type !== "schedule" && trigger.type !== "event") ||
    (trigger.config !== undefined && !isRecord(trigger.config)) ||
    !isRecord(mapping) ||
    typeof mapping.promptTemplate !== "string" ||
    mapping.promptTemplate.length === 0
  ) {
    throw new Error("The automation template parameter is missing required fields.");
  }

  return {
    name: parsed.name,
    trigger: {
      type: trigger.type,
      ...(trigger.config !== undefined ? { config: trigger.config } : {})
    },
    mapping: { promptTemplate: mapping.promptTemplate },
    kitRef: parsed.kitRef
  };
}

/** The contracts OBJECT kitRef for a market kit (see AutomationTemplate). */
function isMarketKitRef(value: unknown): value is { source: "market"; marketKitId: string; slug: string } {
  if (!isRecord(value)) return false;
  return (
    value.source === "market" &&
    typeof value.marketKitId === "string" && value.marketKitId.length > 0 &&
    typeof value.slug === "string" && value.slug.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
