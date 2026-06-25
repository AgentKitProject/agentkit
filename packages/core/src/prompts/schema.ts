import { z } from "zod";

const kebabIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, numbers, and hyphens");

const inputIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_.-]+$/, "Use letters, numbers, dots, underscores, and hyphens");

export const preparedPromptInputTypeSchema = z.enum([
  "short-text",
  "long-text",
  "choice",
  "multi-choice",
  "date",
  "number",
  "boolean"
]);

export const preparedPromptOutputModeSchema = z.enum(["text", "markdown", "document"]);

export const preparedPromptInputSchema = z
  .object({
    id: inputIdSchema,
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    type: preparedPromptInputTypeSchema,
    required: z.boolean(),
    placeholder: z.string().min(1).optional(),
    defaultValue: z.unknown().optional(),
    choices: z.array(z.string().min(1)).optional(),
    includeInPrompt: z.boolean().default(true)
  })
  .strict();

export const preparedPromptSchema = z
  .object({
    id: kebabIdSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    template: z.string().min(1),
    inputs: z.array(preparedPromptInputSchema).default([]),
    outputMode: preparedPromptOutputModeSchema.optional(),
    documentLikeOutput: z.boolean().optional(),
    suggestedFileName: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional()
  })
  .strict();

export type PreparedPrompt = z.infer<typeof preparedPromptSchema>;
export type PreparedPromptInput = z.infer<typeof preparedPromptInputSchema>;
export type PreparedPromptInputType = z.infer<typeof preparedPromptInputTypeSchema>;
export type PreparedPromptOutputMode = z.infer<typeof preparedPromptOutputModeSchema>;
