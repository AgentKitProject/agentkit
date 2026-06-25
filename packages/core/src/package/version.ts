import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export interface SetAgentKitVersionResult {
  previous: string;
  next: string;
}

// The Agent Kit content `version` is a simple AUTO-INCREMENTING SEQUENTIAL
// integer, starting at 1 and displayed to authors as `v1, v2, v3…`. It is
// deliberately NOT semver — semver is too software-oriented for non-technical
// kit authors.
//
// Representation: a positive-integer STRING ("1", "2", …). The kit's manifest
// `version`, getAgentKitSummary, and the Forge upload payload
// (`forgeUploadBackendRequest.version` = z.string()) are all string-typed, so
// keeping the canonical form a string avoids coercion at every boundary. The
// YAML scalar is written double-quoted so it stays a string on disk.
//
// NOTE: this is the kit's CONTENT version. It is unrelated to
// `schemaVersion` ("0.1"), which is the spec FORMAT version and is untouched.
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

/**
 * True when `value` is a positive-integer version (string "1","2",… or the
 * equivalent positive integer number). Zero, negatives, decimals, leading
 * zeros, and semver strings are all rejected.
 */
export function isValidAgentKitVersion(value: string | number): boolean {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1;
  }
  return typeof value === "string" && POSITIVE_INTEGER_PATTERN.test(value);
}

/**
 * Format a content version for display in UI, e.g. `1` → `"v1"`.
 */
export function formatDisplayVersion(version: string | number): string {
  return `v${normalizeVersion(version)}`;
}

/**
 * Normalize any raw `version` value to its canonical positive-integer string.
 *
 * Legacy kits carry a semver `version` (e.g. "0.1.0") or some other value. Per
 * the product decision, anything that is not already a positive integer is
 * treated as `"1"` (the first sequential version).
 */
function normalizeVersion(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return String(value);
  }
  if (typeof value === "string" && POSITIVE_INTEGER_PATTERN.test(value)) {
    return value;
  }
  return "1";
}

/**
 * Normalize any raw `version` value to its canonical positive integer.
 *
 * Mirrors {@link normalizeVersion} (legacy/non-integer → 1) but returns a
 * `number` for ordering comparisons (e.g. update checks). Exported so callers
 * compare versions without re-implementing the legacy-normalization rule.
 */
export function normalizeVersionToInt(value: unknown): number {
  return Number(normalizeVersion(value));
}

function manifestPathFor(rootPath: string): string {
  return path.join(path.resolve(rootPath), "agentkit.yaml");
}

/**
 * Read the raw `version` scalar (number or string) from a parsed manifest.
 * The field must be present and non-empty; its shape is validated/normalized
 * by callers.
 */
function extractRawVersion(doc: YAML.Document.Parsed): string | number {
  const value = doc.get("version");
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && value.length === 0)
  ) {
    throw new Error(
      "Agent Kit manifest is missing a `version` field in agentkit.yaml."
    );
  }

  return value;
}

async function loadManifestDoc(rootPath: string): Promise<{
  manifestPath: string;
  doc: YAML.Document.Parsed;
}> {
  const manifestPath = manifestPathFor(rootPath);
  const rawText = await readFile(manifestPath, "utf8");
  const doc = YAML.parseDocument(rawText);
  if (doc.errors.length > 0) {
    throw new Error(`Could not parse agentkit.yaml: ${doc.errors[0]?.message}`);
  }
  return { manifestPath, doc };
}

/**
 * Read the current sequential content `version` from a kit's `agentkit.yaml`,
 * normalized to a positive-integer string. Legacy semver (or any non-integer)
 * version is reported as `"1"`.
 */
export async function getAgentKitVersion(rootPath: string): Promise<string> {
  const { doc } = await loadManifestDoc(rootPath);
  return normalizeVersion(extractRawVersion(doc));
}

function writeVersionNode(doc: YAML.Document.Parsed, version: string): void {
  // Mutate the existing scalar node in place so any comment attached to the
  // version line (and the rest of the document) is preserved. Force a
  // double-quoted style so the sequential integer stays a YAML string rather
  // than being re-emitted as a YAML number.
  const versionNode = doc.get("version", true) as YAML.Scalar | undefined;
  if (versionNode && typeof versionNode === "object" && "value" in versionNode) {
    versionNode.value = version;
    versionNode.type = YAML.Scalar.QUOTE_DOUBLE;
  } else {
    const node = new YAML.Scalar(version);
    node.type = YAML.Scalar.QUOTE_DOUBLE;
    doc.set("version", node);
  }
}

/**
 * Set the `version` field of a kit's `agentkit.yaml` manifest in place.
 *
 * `nextVersion` must be a positive integer (string "2" or number 2). The rest
 * of the manifest (comments, key order, formatting) is preserved by editing
 * the parsed YAML document rather than reserializing a plain object.
 *
 * The returned `previous` is the normalized current version: a legacy semver
 * value reads back as `"1"`.
 */
export async function setAgentKitVersion(
  rootPath: string,
  nextVersion: string | number
): Promise<SetAgentKitVersionResult> {
  if (!isValidAgentKitVersion(nextVersion)) {
    throw new Error(
      `Invalid version "${nextVersion}". Expected a positive integer (for example "2"), displayed as v2.`
    );
  }

  const next = String(nextVersion);
  const { manifestPath, doc } = await loadManifestDoc(rootPath);
  const previous = normalizeVersion(extractRawVersion(doc));

  writeVersionNode(doc, next);
  await writeFile(manifestPath, String(doc), "utf8");

  return { previous, next };
}

/**
 * Auto-increment a kit's sequential content version: read the current version
 * (normalizing legacy semver to 1), add 1, write it back, and return the
 * previous/next pair. This is the primary way authors advance a kit version.
 */
export async function nextAgentKitVersion(
  rootPath: string
): Promise<SetAgentKitVersionResult> {
  const current = await getAgentKitVersion(rootPath);
  const next = String(Number(current) + 1);
  return setAgentKitVersion(rootPath, next);
}
