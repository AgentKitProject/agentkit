import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveInside, safeListFilesRecursive } from "../fs/safety.js";
import { listPreparedPrompts } from "../prompts/prompts.js";
import type { PreparedPrompt } from "../prompts/schema.js";

const TOP_LEVEL_FILES = ["START_HERE.md", "AGENTKIT.md"] as const;
const OPTIONAL_DIRECTORIES = ["workflows", "policies", "templates"] as const;

export async function exportOneFile(rootPath: string, outFile: string): Promise<string> {
  const resolvedRoot = path.resolve(rootPath);
  const sections: string[] = [];

  for (const file of TOP_LEVEL_FILES) {
    await appendFileSection(sections, resolvedRoot, file);
  }

  for (const skillFile of await listSkillFiles(resolvedRoot)) {
    await appendFileSection(sections, resolvedRoot, skillFile);
  }

  for (const directory of OPTIONAL_DIRECTORIES) {
    await appendDirectorySections(sections, resolvedRoot, directory);
  }

  await appendPreparedPromptSections(sections, resolvedRoot);

  const resolvedOut = path.resolve(outFile);
  await mkdir(path.dirname(resolvedOut), { recursive: true });
  await writeFile(resolvedOut, sections.join("\n\n"), "utf8");
  return resolvedOut;
}

async function appendPreparedPromptSections(sections: string[], rootPath: string): Promise<void> {
  const prompts = await listPreparedPrompts(rootPath);
  if (prompts.length === 0) {
    return;
  }

  sections.push(`## Prepared Prompts\n\n${prompts.map(renderPromptSection).join("\n\n")}`);
}

function renderPromptSection(prompt: PreparedPrompt): string {
  const inputs =
    prompt.inputs.length === 0
      ? "None"
      : prompt.inputs
          .map((input) => `- ${input.id} (${input.type}${input.required ? ", required" : ", optional"}): ${input.label}`)
          .join("\n");

  return `### ${prompt.name}

${prompt.description}

**Template**

\`\`\`text
${prompt.template}
\`\`\`

**Inputs**

${inputs}`;
}

async function appendDirectorySections(
  sections: string[],
  rootPath: string,
  relativeDirectory: string
): Promise<void> {
  const directoryPath = path.join(rootPath, relativeDirectory);
  if (!(await exists(directoryPath))) {
    return;
  }

  for (const file of await listMarkdownFiles(rootPath, relativeDirectory)) {
    await appendFileSection(sections, rootPath, file);
  }
}

async function appendFileSection(
  sections: string[],
  rootPath: string,
  relativePath: string
): Promise<void> {
  const normalizedRelativePath = relativePath.replaceAll("\\", "/");
  const content = await readFile(resolveInside(rootPath, relativePath), "utf8");
  sections.push(`<!-- BEGIN ${normalizedRelativePath} -->\n\n${content.trim()}\n\n<!-- END ${normalizedRelativePath} -->`);
}

async function listSkillFiles(rootPath: string): Promise<string[]> {
  const skillsRoot = resolveInside(rootPath, "skills");
  if (!(await exists(skillsRoot))) {
    return [];
  }

  return (await safeListFilesRecursive(skillsRoot))
    .filter((file) => file.relativePath.split("/").length === 2 && file.relativePath.endsWith("/SKILL.md"))
    .map((file) => `skills/${file.relativePath}`)
    .sort();
}

async function listMarkdownFiles(rootPath: string, relativeDirectory: string): Promise<string[]> {
  const directoryPath = resolveInside(rootPath, relativeDirectory);
  return (await safeListFilesRecursive(directoryPath))
    .filter((file) => file.relativePath.toLowerCase().endsWith(".md"))
    .map((file) => `${relativeDirectory}/${file.relativePath}`)
    .sort();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
