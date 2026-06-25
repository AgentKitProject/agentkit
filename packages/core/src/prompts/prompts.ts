import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { resolveInside } from "../fs/safety.js";
import { readAgentKit } from "../package/reader.js";
import type { AgentKitManifest, ValidationIssue } from "../types.js";
import { preparedPromptSchema, type PreparedPrompt, type PreparedPromptInput } from "./schema.js";

export interface PreparedPromptInputValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export type PreparedPromptInputValues = Record<string, unknown>;

export interface PreparedPromptRenderResult {
  renderedPrompt: string;
  missingInputs: string[];
  unresolvedVariables: string[];
  warnings: string[];
  valid: boolean;
}

export function extractPromptVariables(template: string): string[] {
  return [...new Set([...matchPromptVariables(template)].map((match) => match.name))].sort();
}

export function findUnresolvedPromptVariables(renderedPrompt: string): string[] {
  return extractPromptVariables(renderedPrompt);
}

export async function listPreparedPrompts(kitPath: string): Promise<PreparedPrompt[]> {
  const kit = await readAgentKit(kitPath);
  const promptRefs = kit.manifest?.prompts;
  const promptPaths =
    promptRefs && promptRefs.length > 0
      ? promptRefs.map((prompt) => prompt.path)
      : await findPromptFiles(kit.rootPath);

  const prompts = await Promise.all(
    promptPaths.sort().map(async (promptPath) => {
      const prompt = await loadPreparedPrompt(resolveInside(kit.rootPath, promptPath));
      const manifestPrompt = promptRefs?.find((entry) => entry.path === promptPath);
      if (manifestPrompt && manifestPrompt.id !== prompt.id) {
        throw new Error(
          `Prepared prompt id mismatch for ${promptPath}: manifest has ${manifestPrompt.id}, file has ${prompt.id}`
        );
      }

      return prompt;
    })
  );

  return prompts.sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadPreparedPrompt(filePath: string): Promise<PreparedPrompt> {
  const parsed = preparedPromptSchema.safeParse(YAML.parse(await readFile(filePath, "utf8")));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid prepared prompt ${filePath}: ${details}`);
  }

  return parsed.data;
}

export function validatePreparedPromptInputs(
  prompt: PreparedPrompt,
  inputValues: PreparedPromptInputValues
): PreparedPromptInputValidationReport {
  const issues: ValidationIssue[] = [];
  const templateVariables = extractPromptVariables(prompt.template);
  const inputIds = new Set(prompt.inputs.map((input) => input.id));

  for (const variable of templateVariables) {
    if (!inputIds.has(variable)) {
      issues.push({
        severity: "error",
        code: "prompt.placeholder.undefined",
        message: `Prepared prompt template references undefined input: ${variable}`,
        path: variable
      });
    }
  }

  for (const input of prompt.inputs) {
    const value = inputValues[input.id] ?? input.defaultValue;
    if (isMissing(value)) {
      if (input.required) {
        issues.push({
          severity: "error",
          code: "prompt.input.required",
          message: `Missing required prompt input: ${input.id}`,
          path: input.id
        });
      }
      continue;
    }

    issues.push(...validateInputValue(input, value));
  }

  return {
    valid: issues.length === 0,
    issues
  };
}

export function renderPreparedPrompt(
  prompt: PreparedPrompt,
  inputValues: PreparedPromptInputValues
): string {
  const result = renderPreparedPromptWithValidation(prompt, inputValues);
  if (!result.valid) {
    const messages = [
      ...result.missingInputs.map((input) => `Missing required prompt input: ${input}`),
      ...(result.unresolvedVariables.length > 0
        ? [`Unresolved prompt variables: ${result.unresolvedVariables.join(", ")}`]
        : [])
    ];
    throw new Error(messages.join("; "));
  }

  return result.renderedPrompt;
}

export function renderPreparedPromptWithValidation(
  prompt: PreparedPrompt,
  inputValues: PreparedPromptInputValues
): PreparedPromptRenderResult {
  const report = validatePreparedPromptInputs(prompt, inputValues);
  const missingInputs = report.issues
    .filter((issue) => issue.code === "prompt.input.required")
    .map((issue) => issue.path ?? "");
  const renderedPrompt = replacePromptVariables(prompt.template, (inputId, original) => {
    const input = prompt.inputs.find((entry) => entry.id === inputId);
    if (!input) {
      return original;
    }
    const value = inputValues[inputId] ?? input?.defaultValue;
    if (isMissing(value) && input.required) {
      return original;
    }
    return isMissing(value) ? "" : stringifyPromptValue(value);
  });
  const unresolvedVariables = findUnresolvedPromptVariables(renderedPrompt);

  return {
    renderedPrompt,
    missingInputs,
    unresolvedVariables,
    warnings: [],
    valid: report.valid && unresolvedVariables.length === 0
  };
}

export function getDefaultArtifactNames(input: {
  id: string;
  version: string;
  timestamp?: Date;
}): { onefile: string; package: string; output: string } {
  const stamp = formatTimestamp(input.timestamp ?? new Date());
  return {
    onefile: `${input.id}-${input.version}.onefile.md`,
    package: `${input.id}-${input.version}.agentkit.zip`,
    output: `${input.id}-output-${stamp}.md`
  };
}

export function getDefaultArtifactNamesForManifest(
  manifest: AgentKitManifest,
  timestamp?: Date
): { onefile: string; package: string; output: string } {
  return getDefaultArtifactNames({ id: manifest.id, version: manifest.version, timestamp });
}

async function findPromptFiles(rootPath: string): Promise<string[]> {
  const promptsPath = path.join(rootPath, "prompts");
  if (!(await exists(promptsPath))) {
    return [];
  }

  const entries = await readdir(promptsPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".yaml"))
    .map((entry) => `prompts/${entry.name}`)
    .sort();
}

function validateInputValue(input: PreparedPromptInput, value: unknown): ValidationIssue[] {
  const issue = (message: string): ValidationIssue => ({
    severity: "error",
    code: "prompt.input.invalid",
    message,
    path: input.id
  });

  switch (input.type) {
    case "short-text":
    case "long-text":
    case "date":
      return typeof value === "string" ? [] : [issue(`Prompt input ${input.id} must be a string`)];
    case "number":
      return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)))
        ? []
        : [issue(`Prompt input ${input.id} must be a number`)];
    case "boolean":
      return typeof value === "boolean" ? [] : [issue(`Prompt input ${input.id} must be a boolean`)];
    case "choice":
      if (typeof value !== "string") {
        return [issue(`Prompt input ${input.id} must be a string choice`)];
      }
      return input.choices && !input.choices.includes(value)
        ? [issue(`Prompt input ${input.id} must be one of: ${input.choices.join(", ")}`)]
        : [];
    case "multi-choice":
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return [issue(`Prompt input ${input.id} must be an array of string choices`)];
      }
      return input.choices && value.some((item) => !input.choices?.includes(item))
        ? [issue(`Prompt input ${input.id} contains an unsupported choice`)]
        : [];
  }
}

function stringifyPromptValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
}

function replacePromptVariables(
  template: string,
  getValue: (inputId: string, original: string) => string
): string {
  return template
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match: string, inputId: string) =>
      getValue(inputId, match)
    )
    .replace(/\{(?!\{)\s*([a-zA-Z0-9_.-]+)\s*\}(?!\})/g, (match: string, inputId: string) =>
      getValue(inputId, match)
    );
}

function matchPromptVariables(template: string): Array<{ name: string }> {
  const matches: Array<{ name: string }> = [];
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
    matches.push({ name: match[1] });
  }
  for (const match of template.matchAll(/\{(?!\{)\s*([a-zA-Z0-9_.-]+)\s*\}(?!\})/g)) {
    matches.push({ name: match[1] });
  }
  return matches;
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
}
