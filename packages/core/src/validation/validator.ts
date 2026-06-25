import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { resolveInside, safeListFilesRecursive, normalizePath } from "../fs/safety.js";
import { agentKitManifestSchema } from "../schema/agentkit.js";
import { readYamlFile } from "../package/reader.js";
import { loadPreparedPrompt } from "../prompts/prompts.js";
import type {
  AgentKitManifest,
  AgentKitValidationProfile,
  ValidationIssue,
  ValidationReport
} from "../types.js";
import { validateSkillFile } from "./skill.js";

const PROFILE_REQUIREMENTS: Record<AgentKitValidationProfile, string[]> = {
  "local-valid": ["agentkit.yaml", "AGENTKIT.md", "START_HERE.md", "skills"],
  publishable: [
    "agentkit.yaml",
    "AGENTKIT.md",
    "START_HERE.md",
    "skills",
    "README.md",
    "LICENSE"
  ],
  trusted: [
    "agentkit.yaml",
    "AGENTKIT.md",
    "START_HERE.md",
    "skills",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "policies",
    "examples"
  ],
  verified: [
    "agentkit.yaml",
    "AGENTKIT.md",
    "START_HERE.md",
    "skills",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "policies",
    "examples",
    "evals"
  ]
};

export async function validateAgentKit(
  rootPath: string,
  profile: AgentKitValidationProfile = "local-valid"
): Promise<ValidationReport> {
  const resolvedRoot = path.resolve(rootPath);
  const issues: ValidationIssue[] = [];

  for (const requiredPath of PROFILE_REQUIREMENTS[profile]) {
    if (!(await exists(path.join(resolvedRoot, requiredPath)))) {
      issues.push({
        severity: "error",
        code: "package.required_path.missing",
        message: `Missing required ${isLikelyFile(requiredPath) ? "file" : "folder"}: ${requiredPath}`,
        path: requiredPath
      });
    }
  }

  let manifest: AgentKitManifest | undefined;
  const manifestPath = path.join(resolvedRoot, "agentkit.yaml");

  if (await exists(manifestPath)) {
    try {
      const manifestRaw = await readYamlFile(manifestPath);
      const parsed = agentKitManifestSchema.safeParse(manifestRaw);
      if (parsed.success) {
        manifest = parsed.data as AgentKitManifest;
      } else {
        issues.push(...zodIssuesToValidationIssues(parsed.error, "agentkit.yaml"));
      }
    } catch (error) {
      issues.push({
        severity: "error",
        code: "manifest.invalid_yaml",
        message: error instanceof Error ? error.message : "Unable to parse agentkit.yaml",
        path: "agentkit.yaml"
      });
    }
  }

  const skillsRoot = path.join(resolvedRoot, "skills");
  if (await exists(skillsRoot)) {
    const skillFiles = await findSkillFiles(skillsRoot);
    if (skillFiles.length === 0) {
      issues.push({
        severity: "error",
        code: "skill.required.missing",
        message: "At least one skills/<skill-id>/SKILL.md file is required",
        path: "skills"
      });
    }
  }

  if (manifest) {
    for (const skill of manifest.skills) {
      let skillPath: string;
      try {
        skillPath = resolveInside(resolvedRoot, skill.path);
      } catch (error) {
        issues.push({
          severity: "error",
          code: "manifest.skill_path.unsafe",
          message: error instanceof Error ? error.message : `Unsafe skill path: ${skill.path}`,
          path: skill.path
        });
        continue;
      }
      if (!(await exists(skillPath))) {
        issues.push({
          severity: "error",
          code: "manifest.skill_path.missing",
          message: `Manifest skill path does not exist: ${skill.path}`,
          path: skill.path
        });
        continue;
      }

      issues.push(...(await validateSkillFile(skillPath)));
    }

    issues.push(...(await validateDeclaredScripts(resolvedRoot, manifest)));
    issues.push(...(await validatePreparedPromptFiles(resolvedRoot, manifest)));
  }

  return {
    valid: issues.every((issue) => issue.severity !== "error"),
    profile,
    rootPath: resolvedRoot,
    issues
  };
}

async function validatePreparedPromptFiles(
  rootPath: string,
  manifest: AgentKitManifest
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  for (const prompt of manifest.prompts ?? []) {
    let promptPath: string;
    try {
      promptPath = resolveInside(rootPath, prompt.path);
    } catch (error) {
      issues.push({
        severity: "error",
        code: "manifest.prompt_path.unsafe",
        message: error instanceof Error ? error.message : `Unsafe prepared prompt path: ${prompt.path}`,
        path: prompt.path
      });
      continue;
    }
    if (!(await exists(promptPath))) {
      issues.push({
        severity: "error",
        code: "manifest.prompt_path.missing",
        message: `Manifest prepared prompt path does not exist: ${prompt.path}`,
        path: prompt.path
      });
      continue;
    }

    try {
      const loadedPrompt = await loadPreparedPrompt(promptPath);
      if (loadedPrompt.id !== prompt.id) {
        issues.push({
          severity: "error",
          code: "prompt.id.mismatch",
          message: `Prepared prompt id mismatch: manifest has ${prompt.id}, file has ${loadedPrompt.id}`,
          path: prompt.path
        });
      }
    } catch (error) {
      issues.push({
        severity: "error",
        code: "prompt.invalid",
        message: error instanceof Error ? error.message : "Invalid prepared prompt",
        path: prompt.path
      });
    }
  }

  return issues;
}

function zodIssuesToValidationIssues(error: ZodError, filePath: string): ValidationIssue[] {
  return error.issues.map((issue) => {
    const issuePath = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return {
      severity: "error",
      code: "manifest.field.invalid",
      message: `Invalid or missing manifest field ${issuePath}: ${issue.message}`,
      path: filePath
    };
  });
}

async function validateDeclaredScripts(
  rootPath: string,
  manifest: AgentKitManifest
): Promise<ValidationIssue[]> {
  const scriptsPath = path.join(rootPath, "scripts");
  if (!(await exists(scriptsPath))) {
    return [];
  }

  const scriptFiles = (await safeListFilesRecursive(scriptsPath)).map((file) => file.absolutePath);
  if (scriptFiles.length === 0) {
    return [];
  }

  const declared = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const script of manifest.scripts ?? []) {
    const scriptPath = typeof script === "string" ? script : script.path;
    try {
      declared.add(normalizePath(path.relative(rootPath, resolveInside(rootPath, scriptPath))));
    } catch (error) {
      issues.push({
        severity: "error",
        code: "scripts.path.unsafe",
        message: error instanceof Error ? error.message : `Unsafe script path: ${scriptPath}`,
        path: scriptPath
      });
    }
  }

  return [
    ...issues,
    ...scriptFiles
    .map((file) => normalizePath(path.relative(rootPath, file)))
    .filter((file) => !declared.has(file))
    .map((file) => ({
      severity: "error" as const,
      code: "scripts.undeclared",
      message: `Script file is not declared in agentkit.yaml: ${file}`,
      path: file
    }))
  ];
}

async function findSkillFiles(skillsRoot: string): Promise<string[]> {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skillFiles: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
    if (await exists(skillPath)) {
      skillFiles.push(skillPath);
    }
  }

  return skillFiles;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isLikelyFile(requiredPath: string): boolean {
  return path.extname(requiredPath) !== "" || requiredPath === "LICENSE";
}
