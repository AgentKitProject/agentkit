import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { safeListFilesRecursive } from "../fs/safety.js";

export interface PackageAgentKitOptions {
  maxFiles?: number;
  maxBytes?: number;
}

export async function packageAgentKit(
  rootPath: string,
  outFile: string,
  options: PackageAgentKitOptions = {}
): Promise<string> {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedOut = path.resolve(outFile);
  const zip = new JSZip();

  for (const file of await safeListFilesRecursive(resolvedRoot, options)) {
    if (shouldSkip(file.relativePath, resolvedOut, file.absolutePath)) {
      continue;
    }

    zip.file(file.relativePath, await readFile(file.absolutePath));
  }

  const output = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE"
  });

  await mkdir(path.dirname(resolvedOut), { recursive: true });
  await writeFile(resolvedOut, output);
  return resolvedOut;
}

function shouldSkip(relativePath: string, outFile: string, filePath: string): boolean {
  const normalizedOut = path.resolve(outFile);
  const normalizedFile = path.resolve(filePath);

  return (
    normalizedFile === normalizedOut ||
    relativePath.startsWith("exports/") ||
    relativePath === ".DS_Store"
  );
}
