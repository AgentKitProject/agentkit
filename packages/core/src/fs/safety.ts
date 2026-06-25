import { cp, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface SafeTraversalOptions {
  maxFiles?: number;
  maxBytes?: number;
  excludeDirs?: string[];
  excludePaths?: string[];
  onWarning?: (warning: string) => void;
}

export interface SafeFileEntry {
  absolutePath: string;
  relativePath: string;
  size: number;
}

export const DEFAULT_MAX_FILES = 1000;
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

const DEFAULT_EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build"]);
const DEFAULT_EXCLUDED_PATHS = ["exports/"];
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function assertSafeId(id: string, label = "id"): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`${label} must use lowercase letters, numbers, and hyphens`);
  }
  if (WINDOWS_RESERVED_NAMES.test(id)) {
    throw new Error(`${label} must not use a Windows reserved device name`);
  }
}

export function isSafeId(id: string): boolean {
  try {
    assertSafeId(id);
    return true;
  } catch {
    return false;
  }
}

export function sanitizePathSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "agentkit";
}

export function assertSafeRelativePath(relativePath: string): void {
  if (!relativePath) {
    throw new Error("Path must not be empty");
  }
  if (relativePath.includes("\0")) {
    throw new Error("Path must not contain null bytes");
  }
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("//")) {
    throw new Error(`Path must not use UNC or extended-length syntax: ${relativePath}`);
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Path must not use a Windows drive prefix: ${relativePath}`);
  }
  if (path.isAbsolute(relativePath) || path.posix.isAbsolute(normalized)) {
    throw new Error(`Path must be relative: ${relativePath}`);
  }

  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Path must not contain '..': ${relativePath}`);
  }
}

export function resolveInside(root: string, relativePath: string): string {
  assertSafeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (!isInsideOrEqual(resolvedRoot, resolvedPath)) {
    throw new Error(`Path escapes root: ${relativePath}`);
  }
  return resolvedPath;
}

export async function assertSafeDirectoryForCleanup(targetPath: string): Promise<void> {
  if (!targetPath) {
    throw new Error("Refusing to clean empty path");
  }
  const resolvedTarget = path.resolve(targetPath);
  const parsed = path.parse(resolvedTarget);
  const home = path.resolve(os.homedir());
  const cwd = path.resolve(process.cwd());
  const key = comparablePath(resolvedTarget);

  if (key === comparablePath(parsed.root)) {
    throw new Error(`Refusing to clean filesystem root: ${resolvedTarget}`);
  }
  if (key === comparablePath(home)) {
    throw new Error(`Refusing to clean user home directory: ${resolvedTarget}`);
  }
  if (key === comparablePath(cwd)) {
    throw new Error(`Refusing to clean current repository root: ${resolvedTarget}`);
  }

  const stats = await lstat(resolvedTarget);
  if (!stats.isDirectory()) {
    throw new Error(`Refusing to clean non-directory path: ${resolvedTarget}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to clean symbolic link: ${resolvedTarget}`);
  }
}

export async function safeRemoveDirectoryContents(targetPath: string): Promise<void> {
  await assertSafeDirectoryForCleanup(targetPath);
  for (const entry of await readdir(targetPath)) {
    const entryPath = path.join(targetPath, entry);
    const entryStats = await lstat(entryPath);
    await rm(entryPath, { recursive: !entryStats.isSymbolicLink(), force: true });
  }
}

export async function assertSafeDestinationDirectory(destinationRoot: string): Promise<void> {
  const resolved = path.resolve(destinationRoot);
  const parsed = path.parse(resolved);
  const home = path.resolve(os.homedir());
  const key = comparablePath(resolved);
  if (key === comparablePath(parsed.root)) {
    throw new Error(`Refusing to use filesystem root: ${resolved}`);
  }
  if (key === comparablePath(home)) {
    throw new Error(`Refusing to use user home directory: ${resolved}`);
  }
  if (await exists(resolved)) {
    const stats = await lstat(resolved);
    if (!stats.isDirectory()) {
      throw new Error(`Refusing to use non-directory path: ${resolved}`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to use symbolic link: ${resolved}`);
    }
  }
}

export async function safeListFilesRecursive(
  root: string,
  options: SafeTraversalOptions = {}
): Promise<SafeFileEntry[]> {
  const resolvedRoot = path.resolve(root);
  const rootStats = await lstat(resolvedRoot);
  if (rootStats.isSymbolicLink()) {
    throw new Error(`Refusing to traverse symbolic link: ${resolvedRoot}`);
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`Refusing to traverse non-directory path: ${resolvedRoot}`);
  }
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const excludedDirs = new Set([...DEFAULT_EXCLUDED_DIRS, ...(options.excludeDirs ?? [])]);
  const excludedPaths = [...DEFAULT_EXCLUDED_PATHS, ...(options.excludePaths ?? [])];
  const files: SafeFileEntry[] = [];
  let totalBytes = 0;

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excludedDirs.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const stats = await lstat(absolutePath);
      const relativePath = normalizePath(path.relative(resolvedRoot, absolutePath));
      if (excludedPaths.some((excluded) => relativePath === excluded || relativePath.startsWith(excluded))) {
        continue;
      }
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to traverse symbolic link: ${relativePath}`);
      }
      if (stats.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }

      files.push({ absolutePath, relativePath, size: stats.size });
      totalBytes += stats.size;
      if (files.length > maxFiles) {
        throw new Error(`File count limit exceeded: ${files.length} > ${maxFiles}`);
      }
      if (totalBytes > maxBytes) {
        throw new Error(`Total byte limit exceeded: ${totalBytes} > ${maxBytes}`);
      }
    }
  }

  await walk(resolvedRoot);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function safeCopyDirectory(
  sourceRoot: string,
  destinationRoot: string,
  options: SafeTraversalOptions = {}
): Promise<void> {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  const files = await safeListFilesRecursive(source, options);
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const destinationFile = resolveInside(destination, file.relativePath);
    await mkdir(path.dirname(destinationFile), { recursive: true });
    await cp(file.absolutePath, destinationFile);
  }
}

export function isInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizePath(input: string): string {
  return input.replaceAll("\\", "/");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function comparablePath(input: string): string {
  const normalized = path.resolve(input);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
