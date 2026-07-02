// Automation template deep link — the ?template=<base64url JSON> contract.
//
// Market (built by another agent to THIS exact contract) links into Auto with
//   ?section=automations&template=<base64url of JSON {
//     name: string,                               // 1–80 chars
//     trigger: { type: TriggerType, config?: object },
//     mapping: { promptTemplate: string },        // 1–4000 chars (S1)
//     kitRef?: KitRef
//   }>
// On mount the Automations section decodes this defensively (garbage → null,
// never a throw) and opens the wizard prefilled.
import {
  kitRefSchema,
  triggerTypeSchema,
  scheduleTriggerConfigSchema,
  eventTriggerConfigSchema,
  watchTriggerConfigSchema,
  rssTriggerConfigSchema,
  runCompletedTriggerConfigSchema,
  emailInTriggerConfigSchema,
  messageTriggerConfigSchema,
  type KitRef,
  type TriggerType
} from "@agentkitforge/contracts";

export type AutomationTemplate = {
  name: string;
  trigger: { type: TriggerType; config?: Record<string, unknown> };
  mapping: { promptTemplate: string };
  kitRef?: KitRef;
};

const CONFIG_SCHEMAS = {
  schedule: scheduleTriggerConfigSchema,
  event: eventTriggerConfigSchema,
  watch: watchTriggerConfigSchema,
  rss: rssTriggerConfigSchema,
  run_completed: runCompletedTriggerConfigSchema,
  email_in: emailInTriggerConfigSchema,
  message: messageTriggerConfigSchema
} as const;

/** base64url → UTF-8 string, browser (atob) and Node (Buffer) alike. */
function base64urlDecode(raw: string): string | null {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    if (typeof atob === "function") {
      const bin = atob(padded);
      const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** UTF-8 string → base64url (used by tests + any future outbound links). */
export function encodeTemplateParam(template: AutomationTemplate): string {
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Decode + defensively validate a ?template= parameter. Any structural
 * garbage — bad base64, bad JSON, missing/oversized name or promptTemplate,
 * unknown trigger type, malformed kitRef — returns null (the wizard opens
 * blank instead). A present-but-invalid per-type `config` is DROPPED while the
 * rest of the template survives (partial prefill beats none).
 */
export function decodeTemplateParam(raw: string | null | undefined): AutomationTemplate | null {
  if (!raw) return null;
  const json = base64urlDecode(raw);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const name = parsed.name;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 80) return null;

  if (!isPlainObject(parsed.trigger)) return null;
  const typeResult = triggerTypeSchema.safeParse(parsed.trigger.type);
  if (!typeResult.success) return null;
  const type = typeResult.data;

  if (!isPlainObject(parsed.mapping)) return null;
  const promptTemplate = parsed.mapping.promptTemplate;
  if (typeof promptTemplate !== "string" || promptTemplate.trim().length === 0 || promptTemplate.length > 4000) {
    return null;
  }

  const template: AutomationTemplate = {
    name: name.trim(),
    trigger: { type },
    mapping: { promptTemplate }
  };

  // Optional per-type config: keep only when it parses against the matching
  // contract schema; otherwise silently drop it.
  if (parsed.trigger.config !== undefined) {
    const configResult = CONFIG_SCHEMAS[type].safeParse(parsed.trigger.config);
    if (configResult.success) {
      template.trigger.config = configResult.data as Record<string, unknown>;
    }
  }

  // Optional kitRef: a malformed one invalidates the whole template (a wrong
  // kit silently selected would be worse than no prefill).
  if (parsed.kitRef !== undefined) {
    const kitResult = kitRefSchema.safeParse(parsed.kitRef);
    if (!kitResult.success) return null;
    template.kitRef = kitResult.data;
  }

  return template;
}
