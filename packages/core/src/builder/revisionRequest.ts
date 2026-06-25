import { z } from "zod";
import type { ExampleInputDocument } from "../app/exampleInputDocuments.js";
import { summarizeExampleInputDocument } from "../app/exampleInputDocuments.js";
import { agentKitDraftSchema, type AgentKitDraft } from "../draft/schema.js";
import type { AgentKitValidationProfile } from "../types.js";
import { createAgentKitBuilderInstructions } from "./instructions.js";

export interface CreateAgentKitDraftRevisionRequestInput {
  currentDraft: AgentKitDraft;
  changeRequest: string;
  originalRequest?: string;
  desiredValidationLevel?: AgentKitValidationProfile;
  constraints?: string[];
  sourceNotes?: string[];
  requestedSections?: string[];
  excludedSections?: string[];
  exampleInputDocuments?: ExampleInputDocument[];
}

export interface AgentKitDraftRevisionRequest {
  responseFormatName: "agent_kit_draft_revision";
  builderInstructions: string;
  systemInstructions: string;
  userPrompt: string;
  expectedJsonSchema: unknown;
  warnings: string[];
  input: CreateAgentKitDraftRevisionRequestInput;
}

export function createAgentKitDraftRevisionRequest(
  input: CreateAgentKitDraftRevisionRequestInput
): AgentKitDraftRevisionRequest {
  const parsedDraft = agentKitDraftSchema.safeParse(input.currentDraft);
  if (!parsedDraft.success) {
    throw new Error(
      `Invalid current AgentKitDraft: ${parsedDraft.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`
    );
  }

  if (!input.changeRequest.trim()) {
    throw new Error("changeRequest is required");
  }

  const normalizedInput: CreateAgentKitDraftRevisionRequestInput = {
    ...input,
    currentDraft: parsedDraft.data,
    constraints: normalizeList(input.constraints),
    sourceNotes: normalizeList(input.sourceNotes),
    desiredValidationLevel: input.desiredValidationLevel ?? "local-valid"
  };

  return {
    responseFormatName: "agent_kit_draft_revision",
    builderInstructions: createAgentKitBuilderInstructions,
    systemInstructions:
      "You are revising an existing AgentKitForge AgentKitDraft. Return only the full updated AgentKitDraft JSON. Do not return a patch.",
    userPrompt: buildRevisionPrompt(normalizedInput),
    expectedJsonSchema: {
      title: "AgentKitDraft",
      ...z.toJSONSchema(agentKitDraftSchema)
    },
    warnings: buildRevisionWarnings(normalizedInput),
    input: normalizedInput
  };
}

function buildRevisionPrompt(input: CreateAgentKitDraftRevisionRequestInput): string {
  const lines = [
    "Revise the existing AgentKitDraft JSON.",
    "",
    "Return the full updated AgentKitDraft JSON.",
    "Do not return a patch, diff, prose summary, or Markdown wrapper.",
    "Preserve useful existing content.",
    "Apply the requested change.",
    "Keep IDs stable unless the requested change requires changing them.",
    "Preserve prepared prompts unless asked to remove or change them.",
    "Add prepared prompts and input variables when the user asks for reusable prompts or required inputs.",
    "Generate requested sections. Do not generate excluded sections unless required for validity.",
    "Prefer simple useful kits over overly complex kits.",
    "Do not generate scripts unless scripts are explicitly requested.",
    "Keep output valid against the AgentKitDraft schema.",
    "",
    `Requested change: ${input.changeRequest}`,
    `Desired validation level: ${input.desiredValidationLevel ?? "local-valid"}`
  ];

  if (input.originalRequest) {
    lines.push("", `Original request: ${input.originalRequest}`);
  }

  appendList(lines, "Constraints", input.constraints);
  appendList(lines, "Source notes", input.sourceNotes);
  appendList(lines, "Requested sections", input.requestedSections);
  appendList(lines, "Excluded sections", input.excludedSections);

  if (input.exampleInputDocuments && input.exampleInputDocuments.length > 0) {
    lines.push("", "Example input document summaries:");
    for (const document of input.exampleInputDocuments.map(summarizeExampleInputDocument)) {
      lines.push(`- ${document.name} (${document.filename}, ${document.kind})${document.notes ? `: ${document.notes}` : ""}`);
    }
    lines.push(
      "Use example input documents to infer formatting and expected outputs.",
      "Do not quote excessive source text. Summarize patterns into skills, templates, and prepared prompts."
    );
  }

  lines.push("", "Current AgentKitDraft JSON:", JSON.stringify(input.currentDraft, null, 2));

  return lines.join("\n");
}

function buildRevisionWarnings(input: CreateAgentKitDraftRevisionRequestInput): string[] {
  const warnings: string[] = [];

  if ((input.currentDraft.preparedPrompts ?? []).length > 0) {
    warnings.push("Current draft includes preparedPrompts; preserve or update them unless the change request says otherwise.");
  }

  if (input.desiredValidationLevel === "trusted" || input.desiredValidationLevel === "verified") {
    warnings.push("Trusted and verified outputs should retain or add policies and examples where appropriate.");
  }

  return warnings;
}

function appendList(lines: string[], label: string, values: string[] | undefined): void {
  if (!values || values.length === 0) {
    return;
  }

  lines.push("", `${label}:`);
  for (const value of values) {
    lines.push(`- ${value}`);
  }
}

function normalizeList(values: string[] | undefined): string[] | undefined {
  const normalized = values?.map((value) => value.trim()).filter(Boolean);
  return normalized && normalized.length > 0 ? normalized : undefined;
}
