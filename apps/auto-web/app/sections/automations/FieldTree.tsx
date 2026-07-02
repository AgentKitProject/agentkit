"use client";

// The clickable event-field tree — the non-technical mapping UX. Renders the
// flattened fields of the source's latest event; clicking a LEAF hands its
// dot/bracket path to the parent, which either inserts `{{path}}` into the
// prompt template at the cursor or sets the focused filter row's path.
import { flattenPayloadFields } from "@/lib/automations/field-tree";

export function FieldTree({
  payload,
  onPick
}: {
  payload: unknown;
  /** Called with the leaf's payload path (e.g. "issue.labels[0]"). */
  onPick: (path: string) => void;
}) {
  const fields = flattenPayloadFields(payload);
  if (fields.length === 0) {
    return <p className="form-copy">This event has no readable fields.</p>;
  }
  return (
    <div
      style={{
        maxHeight: 220,
        overflowY: "auto",
        border: "1px solid var(--color-border, rgba(128,128,128,0.25))",
        borderRadius: 8,
        padding: "6px 8px",
        fontSize: "0.8em",
        fontFamily: "var(--font-mono, monospace)"
      }}
    >
      {fields.map((f) => (
        <div key={f.path || f.label} style={{ paddingLeft: f.depth * 14, lineHeight: 1.7 }}>
          {f.isLeaf ? (
            <button
              type="button"
              onClick={() => onPick(f.path)}
              title={`Insert {{${f.path}}}`}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "var(--color-accent, inherit)",
                fontFamily: "inherit",
                fontSize: "inherit",
                textDecoration: "underline dotted"
              }}
            >
              {f.label}
            </button>
          ) : (
            <span style={{ color: "var(--color-text-secondary)" }}>{f.label}</span>
          )}
          {f.preview !== null && (
            <span style={{ color: "var(--color-text-secondary)" }}> : {f.preview}</span>
          )}
        </div>
      ))}
    </div>
  );
}
