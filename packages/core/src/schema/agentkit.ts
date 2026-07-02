import { z } from "zod";
import { assertSafeRelativePath, isSafeId } from "../fs/safety.js";

const safeIdSchema = z.string().min(1).refine(isSafeId, "Use lowercase letters, numbers, and hyphens");
const safePathSchema = z.string().min(1).refine((value) => {
  try {
    assertSafeRelativePath(value);
    return true;
  } catch {
    return false;
  }
}, "Use a safe relative path inside the Agent Kit");

export const agentKitSkillSchema = z.object({
  id: safeIdSchema,
  path: safePathSchema,
  description: z.string().min(1),
  triggers: z.array(z.string().min(1)).min(1)
});

export const agentKitPromptSchema = z.object({
  id: safeIdSchema,
  path: safePathSchema,
  description: z.string().min(1)
});

// Suggested automations are SUGGESTIONS ONLY. They may never carry approvals,
// budgets, destinations, or connections — the human completes those in the
// Auto wizard. That safety rule is enforced structurally: every object below
// is strict(), so unknown keys (e.g. approvalId, destinations, budget,
// connectionId) are rejected outright instead of passing through.
const automationScheduleTriggerSchema = z
  .object({
    type: z.literal("schedule"),
    config: z
      .object({
        // Suggested cron expression + IANA timezone; the wizard treats both
        // as prefills the human can change.
        cron: z.string().min(1).max(120).optional(),
        timezone: z.string().min(1).max(64).optional()
      })
      .strict()
      .optional()
  })
  .strict();

const automationEventTriggerSchema = z
  .object({
    type: z.literal("event"),
    config: z
      .object({
        // Suggested event name only — never a destination or connection.
        eventName: z.string().min(1).max(120).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const agentKitAutomationTriggerSchema = z.discriminatedUnion("type", [
  automationScheduleTriggerSchema,
  automationEventTriggerSchema
]);

export const agentKitAutomationSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    trigger: agentKitAutomationTriggerSchema,
    // REQUIRED: the instruction source the user reviews before enabling.
    promptTemplate: z.string().min(1).max(4000)
  })
  .strict();

export const agentKitAutomationsSchema = z.array(agentKitAutomationSchema).max(10);

export const agentKitManifestSchema = z
  .object({
    schemaVersion: z.string().min(1),
    kind: z.string().min(1),
    id: safeIdSchema,
    name: z.string().min(1),
    // Content version: canonically a sequential positive-integer string
    // ("1","2",…), displayed as vN. Legacy kits may still carry a semver
    // string (e.g. "0.1.0") or a raw YAML integer; both are accepted here and
    // normalized to v1 by the version API. schemaVersion (spec format) is
    // separate and unaffected.
    version: z.union([z.string().min(1), z.number().int().positive()]),
    description: z.string().min(1),
    author: z.object({
      name: z.string().min(1)
    }),
    license: z.string().min(1),
    entrypoints: z.object({
      human: z.string().min(1),
      agent: z.string().min(1)
    }),
    userExperience: z.object({
      setupLevel: z.string().min(1)
    }),
    compatibility: z.object({
      targets: z.array(z.string().min(1)).min(1)
    }),
    risk: z.object({
      level: z.string().min(1)
    }),
    skills: z.array(agentKitSkillSchema).min(1),
    prompts: z.array(agentKitPromptSchema).optional(),
    automations: agentKitAutomationsSchema.optional(),
    scripts: z
      .array(
        z.union([
          safePathSchema,
          z.object({
            id: z.string().min(1).optional(),
            path: safePathSchema,
            description: z.string().min(1).optional()
          })
        ])
      )
      .optional()
  })
  .passthrough();

export type AgentKitManifestInput = z.input<typeof agentKitManifestSchema>;
