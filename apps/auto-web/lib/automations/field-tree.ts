// Flatten an event payload into clickable field rows — the non-technical
// mapping UX behind the wizard's insert-field tree. Clicking a leaf inserts
// `{{path}}` into the prompt template (or sets a filter's path). Paths use the
// same dot/bracket addressing as triggerFilterSchema ("action",
// "issue.labels[0]") so what the user clicks is exactly what the evaluator
// resolves.

export type PayloadField = {
  /** Dot/bracket path into the payload (e.g. "issue.labels[0]"). */
  path: string;
  /** Nesting depth (indentation level). Root keys are 0. */
  depth: number;
  /** The key/index segment shown for this row. */
  label: string;
  /** Short value preview for leaves; null for branches. */
  preview: string | null;
  /** True when the node is a primitive (clickable → insert). */
  isLeaf: boolean;
};

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const DEFAULTS = { maxDepth: 6, maxNodes: 200, maxArrayItems: 5, previewChars: 40 };

function joinPath(parent: string, key: string): string {
  if (IDENT_RE.test(key)) return parent ? `${parent}.${key}` : key;
  // Non-identifier keys use bracket-quoted addressing.
  const quoted = `["${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  return `${parent}${quoted}`;
}

function previewOf(value: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? "undefined";
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Depth-first flatten of `payload` into ordered rows for the field tree.
 * Bounded (depth / node count / array items) so a pathological payload can't
 * hang the wizard — the ingest cap (EVENT_PAYLOAD_MAX_BYTES) already bounds
 * real ones.
 */
export function flattenPayloadFields(
  payload: unknown,
  opts: Partial<typeof DEFAULTS> = {}
): PayloadField[] {
  const { maxDepth, maxNodes, maxArrayItems, previewChars } = { ...DEFAULTS, ...opts };
  const out: PayloadField[] = [];

  const visit = (value: unknown, path: string, label: string, depth: number): void => {
    if (out.length >= maxNodes) return;
    const isObject = typeof value === "object" && value !== null;
    if (!isObject || depth >= maxDepth) {
      out.push({ path, depth, label, preview: previewOf(value, previewChars), isLeaf: true });
      return;
    }
    out.push({ path, depth, label, preview: null, isLeaf: false });
    if (Array.isArray(value)) {
      value.slice(0, maxArrayItems).forEach((item, i) => {
        visit(item, `${path}[${i}]`, `[${i}]`, depth + 1);
      });
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (out.length >= maxNodes) return;
      visit(child, joinPath(path, key), key, depth + 1);
    }
  };

  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    for (const [key, child] of Object.entries(payload as Record<string, unknown>)) {
      if (out.length >= maxNodes) break;
      visit(child, joinPath("", key), key, 0);
    }
  } else if (payload !== undefined) {
    // Non-object payloads still get one addressable root row.
    out.push({ path: "", depth: 0, label: "(payload)", preview: previewOf(payload, previewChars), isLeaf: true });
  }
  return out;
}

/**
 * Insert `{{path}}` into `text` at the given cursor index. Returns the new
 * text and the caret position just after the inserted placeholder (the wizard
 * restores the textarea selection with it).
 */
export function insertPlaceholderAt(
  text: string,
  cursor: number,
  path: string
): { text: string; cursor: number } {
  const at = Math.max(0, Math.min(cursor, text.length));
  const token = `{{${path}}}`;
  return { text: text.slice(0, at) + token + text.slice(at), cursor: at + token.length };
}
