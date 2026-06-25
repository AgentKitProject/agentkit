import { z } from "zod";
import { assertSafeRelativePath } from "../fs/safety.js";
import { preparedPromptSchema } from "../prompts/schema.js";

const idSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, numbers, and hyphens");
const safeRelativePathSchema = z.string().min(1).refine((value) => {
  try {
    assertSafeRelativePath(value);
    return true;
  } catch {
    return false;
  }
}, "Use a safe relative path");

export const skillDraftSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    triggers: z.array(z.string().min(1)).min(1),
    riskLevel: z.string().min(1).default("low"),
    useWhen: z.string().min(1),
    procedure: z.string().min(1),
    output: z.string().min(1)
  })
  .strict();

export const policyDraftSchema = z
  .object({
    id: idSchema,
    description: z.string().min(1).optional(),
    rules: z.array(z.string().min(1)).min(1)
  })
  .strict();

export const exampleDraftSchema = z
  .object({
    id: idSchema,
    prompt: z.string().min(1),
    output: z.string().min(1).optional()
  })
  .strict();

export const templateDraftSchema = z
  .object({
    id: idSchema,
    path: safeRelativePathSchema,
    content: z.string().min(1)
  })
  .strict();

export const agentKitDraftSchema = z
  .object({
    schemaVersion: z.string().min(1).default("0.1"),
    id: idSchema,
    name: z.string().min(1),
    version: z.string().min(1).default("0.1.0"),
    description: z.string().min(1),
    author: z
      .object({
        name: z.string().min(1)
      })
      .strict()
      .default({ name: "Unknown" }),
    license: z.string().min(1).default("MIT"),
    setupLevel: z.string().min(1).default("low"),
    compatibilityTargets: z.array(z.string().min(1)).min(1).default(["codex"]),
    riskLevel: z.string().min(1).default("low"),
    agentInstructions: z.string().min(1).optional(),
    startHere: z.string().min(1).optional(),
    readme: z.string().min(1).optional(),
    changelog: z.string().min(1).optional(),
    skills: z.array(skillDraftSchema).min(1),
    policies: z.array(policyDraftSchema).default([]),
    examples: z.array(exampleDraftSchema).default([]),
    templates: z.array(templateDraftSchema).default([]),
    preparedPrompts: z.array(preparedPromptSchema).default([])
  })
  .strict();

export type SkillDraft = z.infer<typeof skillDraftSchema>;
export type PolicyDraft = z.infer<typeof policyDraftSchema>;
export type ExampleDraft = z.infer<typeof exampleDraftSchema>;
export type TemplateDraft = z.infer<typeof templateDraftSchema>;
export type AgentKitDraft = z.infer<typeof agentKitDraftSchema>;
