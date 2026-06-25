import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveInside, safeRemoveDirectoryContents } from "../fs/safety.js";
import { templates, renderTemplate, type AgentKitTemplateName } from "./templates.js";

export interface CreateAgentKitOptions {
  template: AgentKitTemplateName;
  id: string;
  name: string;
  description: string;
  force?: boolean;
}

export interface CreateAgentKitResult {
  rootPath: string;
  template: AgentKitTemplateName;
  files: string[];
}

export async function createAgentKit(
  targetPath: string,
  options: CreateAgentKitOptions
): Promise<CreateAgentKitResult> {
  const template = templates[options.template];
  if (!template) {
    throw new Error(`Unknown Agent Kit template: ${options.template}`);
  }

  const resolvedRoot = path.resolve(targetPath);
  await assertCanWriteTarget(resolvedRoot, options.force === true);

  const files = Object.entries(template.files);
  for (const [relativePath, content] of files) {
    const filePath = resolveInside(resolvedRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, renderTemplate(content, options), "utf8");
  }

  return {
    rootPath: resolvedRoot,
    template: options.template,
    files: files.map(([relativePath]) => relativePath)
  };
}

async function assertCanWriteTarget(targetPath: string, force: boolean): Promise<void> {
  try {
    const entries = await readdir(targetPath);
    if (entries.length > 0 && !force) {
      throw new Error(
        `Refusing to initialize Agent Kit in non-empty directory: ${targetPath}. Use --force to overwrite template files.`
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

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
