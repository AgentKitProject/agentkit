import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { ZodError } from "zod";
import { assertSafeId, resolveInside, safeRemoveDirectoryContents } from "../fs/safety.js";
import { agentKitDraftSchema, type AgentKitDraft } from "./schema.js";

export interface RenderAgentKitDraftOptions {
  force?: boolean;
}

export interface RenderAgentKitDraftResult {
  rootPath: string;
  files: string[];
}

export class AgentKitDraftValidationError extends Error {
  readonly issues: string[];

  constructor(error: ZodError) {
    const issues = error.issues.map((issue) => {
      const issuePath = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${issuePath}: ${issue.message}`;
    });
    super(`Invalid Agent Kit draft:\n${issues.join("\n")}`);
    this.name = "AgentKitDraftValidationError";
    this.issues = issues;
  }
}

export async function renderAgentKitDraft(
  draftInput: unknown,
  targetDir: string,
  options: RenderAgentKitDraftOptions = {}
): Promise<RenderAgentKitDraftResult> {
  const parsed = agentKitDraftSchema.safeParse(draftInput);
  if (!parsed.success) {
    throw new AgentKitDraftValidationError(parsed.error);
  }

  const draft = parsed.data;
  assertSafeId(draft.id, "draft id");
  for (const skill of draft.skills) {
    assertSafeId(skill.id, "skill id");
  }
  for (const prompt of draft.preparedPrompts) {
    assertSafeId(prompt.id, "prepared prompt id");
  }
  for (const policy of draft.policies) {
    assertSafeId(policy.id, "policy id");
  }
  for (const example of draft.examples) {
    assertSafeId(example.id, "example id");
  }
  const resolvedRoot = path.resolve(targetDir);
  await assertCanWriteTarget(resolvedRoot, options.force === true);

  const files = buildDraftFiles(draft);
  for (const [relativePath, content] of files) {
    const filePath = resolveInside(resolvedRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }

  return {
    rootPath: resolvedRoot,
    files: files.map(([relativePath]) => relativePath)
  };
}

function buildDraftFiles(draft: AgentKitDraft): Array<[string, string]> {
  const skills = [...draft.skills].sort((left, right) => left.id.localeCompare(right.id));
  const policies = [...draft.policies].sort((left, right) => left.id.localeCompare(right.id));
  const examples = [...draft.examples].sort((left, right) => left.id.localeCompare(right.id));
  const templates = [...draft.templates].sort((left, right) => left.id.localeCompare(right.id));
  const preparedPrompts = [...draft.preparedPrompts].sort((left, right) => left.id.localeCompare(right.id));
  const files: Array<[string, string]> = [
    ["agentkit.yaml", renderManifest(draft, skills)],
    ["AGENTKIT.md", renderAgentInstructions(draft)],
    ["START_HERE.md", renderStartHere(draft)],
    ["README.md", renderReadme(draft)],
    ["LICENSE", `${draft.license}\n`],
    ["CHANGELOG.md", draft.changelog ?? "# Changelog\n\n## 0.1.0\n\nInitial draft render.\n"]
  ];

  for (const skill of skills) {
    files.push([`skills/${skill.id}/SKILL.md`, renderSkill(skill)]);
  }

  for (const policy of policies) {
    files.push([`policies/${policy.id}.yaml`, YAML.stringify(policy)]);
  }

  for (const example of examples) {
    files.push([`examples/prompts/${example.id}.md`, markdownWithTitle(example.id, example.prompt)]);
    if (example.output) {
      files.push([`examples/outputs/${example.id}.md`, markdownWithTitle(example.id, example.output)]);
    }
  }

  for (const template of templates) {
    files.push([`templates/${template.path}`, template.content.endsWith("\n") ? template.content : `${template.content}\n`]);
  }

  for (const prompt of preparedPrompts) {
    files.push([`prompts/${prompt.id}.yaml`, YAML.stringify(prompt)]);
  }

  return files;
}

function renderManifest(draft: AgentKitDraft, skills: AgentKitDraft["skills"]): string {
  return YAML.stringify({
    schemaVersion: draft.schemaVersion,
    kind: "AgentKit",
    id: draft.id,
    name: draft.name,
    version: draft.version,
    description: draft.description,
    author: draft.author,
    license: draft.license,
    entrypoints: {
      human: "START_HERE.md",
      agent: "AGENTKIT.md"
    },
    userExperience: {
      setupLevel: draft.setupLevel
    },
    compatibility: {
      targets: draft.compatibilityTargets
    },
    risk: {
      level: draft.riskLevel
    },
    skills: skills.map((skill) => ({
      id: skill.id,
      path: `skills/${skill.id}/SKILL.md`,
      description: skill.description,
      triggers: skill.triggers
    })),
    ...(draft.preparedPrompts.length > 0
      ? {
          prompts: [...draft.preparedPrompts]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((prompt) => ({
              id: prompt.id,
              path: `prompts/${prompt.id}.yaml`,
              description: prompt.description
            }))
        }
      : {})
  });
}

function renderAgentInstructions(draft: AgentKitDraft): string {
  return draft.agentInstructions ?? `# ${draft.name}

Use this Agent Kit when the user's task matches one of the skill triggers.
`;
}

function renderStartHere(draft: AgentKitDraft): string {
  return draft.startHere ?? `# ${draft.name}

${draft.description}
`;
}

function renderReadme(draft: AgentKitDraft): string {
  return draft.readme ?? `# ${draft.name}

${draft.description}
`;
}

function renderSkill(skill: AgentKitDraft["skills"][number]): string {
  const frontmatter = YAML.stringify({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    triggers: skill.triggers,
    riskLevel: skill.riskLevel
  }).trim();

  return `---
${frontmatter}
---

# ${skill.name}

## Use when

${skill.useWhen}

## Procedure

${skill.procedure}

## Output

${skill.output}
`;
}

function markdownWithTitle(id: string, content: string): string {
  if (/^#\s+/m.test(content)) {
    return content.endsWith("\n") ? content : `${content}\n`;
  }

  return `# ${titleFromId(id)}\n\n${content}\n`;
}

async function assertCanWriteTarget(targetPath: string, force: boolean): Promise<void> {
  try {
    const entries = await readdir(targetPath);
    if (entries.length > 0 && !force) {
      throw new Error(
        `Refusing to render Agent Kit draft into non-empty directory: ${targetPath}. Use --force to overwrite generated files.`
      );
    }
    if (entries.length > 0) {
      await safeRemoveDirectoryContents(targetPath);
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      await mkdir(targetPath, { recursive: true });
      return;
    }

    throw error;
  }
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
