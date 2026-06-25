import { z } from "zod";
import type { ExampleInputDocument } from "../app/exampleInputDocuments.js";
import { summarizeExampleInputDocument } from "../app/exampleInputDocuments.js";
import { agentKitDraftSchema } from "../draft/schema.js";
import type { AgentKitValidationProfile } from "../types.js";
import { createAgentKitBuilderInstructions } from "./instructions.js";

export interface CreateAgentKitDraftRequestInput {
  userRequest: string;
  targetUsers?: string[];
  domain?: string;
  desiredValidationLevel?: AgentKitValidationProfile;
  constraints?: string[];
  sourceNotes?: string[];
  existingKitSummary?: string;
  requestedSections?: string[];
  excludedSections?: string[];
  exampleInputDocuments?: ExampleInputDocument[];
}

export interface AgentKitDraftRequest {
  responseFormatName: "agent_kit_draft";
  builderInstructions: string;
  systemInstructions: string;
  userPrompt: string;
  expectedJsonSchema: unknown;
  warnings: string[];
  input: CreateAgentKitDraftRequestInput;
}

export function createAgentKitDraftRequest(
  input: CreateAgentKitDraftRequestInput
): AgentKitDraftRequest {
  if (!input.userRequest.trim()) {
    throw new Error("userRequest is required");
  }

  const normalizedInput: CreateAgentKitDraftRequestInput = {
    ...input,
    targetUsers: normalizeList(input.targetUsers),
    constraints: normalizeList(input.constraints),
    sourceNotes: normalizeList(input.sourceNotes),
    desiredValidationLevel: input.desiredValidationLevel ?? "local-valid"
  };

  return {
    responseFormatName: "agent_kit_draft",
    builderInstructions: createAgentKitBuilderInstructions,
    systemInstructions:
      "You design provider-neutral AgentKitForge AgentKitDraft JSON. Return only JSON matching the supplied schema. Do not call external tools, assume API keys, or add desktop, infrastructure, or marketplace behavior.",
    userPrompt: buildUserPrompt(normalizedInput),
    expectedJsonSchema: {
      title: "AgentKitDraft",
      ...z.toJSONSchema(agentKitDraftSchema)
    },
    warnings: buildWarnings(normalizedInput.desiredValidationLevel ?? "local-valid"),
    input: normalizedInput
  };
}

function buildUserPrompt(input: CreateAgentKitDraftRequestInput): string {
  const lines = [
    "Create an AgentKitDraft JSON object for this request.",
    "",
    `User request: ${input.userRequest}`,
    `Desired validation level: ${input.desiredValidationLevel ?? "local-valid"}`
  ];

  if (input.domain) {
    lines.push(`Domain: ${input.domain}`);
  }

  appendList(lines, "Target users", input.targetUsers);
  appendList(lines, "Constraints", input.constraints);
  appendList(lines, "Source notes", input.sourceNotes);
  appendList(lines, "Requested sections", input.requestedSections);
  appendList(lines, "Excluded sections", input.excludedSections);

  if (!input.requestedSections?.includes("scripts")) {
    lines.push("", "Do not generate scripts unless scripts are explicitly requested.");
  }

  lines.push(
    "Generate requested sections. Do not generate excluded sections unless required for validity.",
    "Prefer simple useful kits over overly complex kits.",
    "Prepared prompts should include inputs and variables when repeatable workflows need them."
  );

  if (input.exampleInputDocuments && input.exampleInputDocuments.length > 0) {
    lines.push("", "Example input document summaries:");
    for (const document of input.exampleInputDocuments.map(summarizeExampleInputDocument)) {
      lines.push(`- ${document.name} (${document.filename}, ${document.kind})${document.notes ? `: ${document.notes}` : ""}`);
    }
    lines.push(
      "Use example input documents to infer formatting, terminology, output style, required inputs, skill procedures, templates, and prepared prompt variables.",
      "Do not quote excessive source text. Summarize patterns into skills, templates, and prepared prompts."
    );
  }

  if (input.existingKitSummary) {
    lines.push("", "Existing kit summary for revision:", input.existingKitSummary);
  }

  lines.push(
    "",
    "Return only an AgentKitDraft JSON object. Keep ids lowercase and hyphenated. Keep Markdown readable."
  );

  return lines.join("\n");
}

function buildWarnings(level: AgentKitValidationProfile): string[] {
  const warnings: string[] = [];

  if (level === "publishable" || level === "trusted" || level === "verified") {
    warnings.push(
      "Publishable kits require README.md and LICENSE. The draft renderer emits these from readme/license fields or defaults."
    );
  }

  if (level === "trusted" || level === "verified") {
    warnings.push(
      "Trusted kits require CHANGELOG.md, policies/, and examples/. Include changelog, at least one policy, and at least one example in the draft."
    );
  }

  if (level === "verified") {
    warnings.push(
      "Verified kits require evals/. AgentKitDraft does not render evals yet, so add eval support before expecting verified output."
    );
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
