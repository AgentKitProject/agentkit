"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditEvent, AuditAction, AuditTargetType } from "@agentkitforge/contracts";
import { Button, Input, Select } from "@agentkitforge/ui";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; items: AuditEvent[]; nextToken?: string }
  | { status: "failed"; message: string };

type Filters = {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  since: string;
  until: string;
};

const emptyFilters: Filters = {
  actorUserId: "",
  action: "",
  targetType: "",
  targetId: "",
  since: "",
  until: ""
};

const TARGET_TYPES: AuditTargetType[] = [
  "submission",
  "kit",
  "org",
  "membership",
  "entitlement",
  "favorite"
];

const ACTIONS: AuditAction[] = [
  "submission.created",
  "submission.validated",
  "submission.approved",
  "submission.rejected",
  "submission.archived",
  "submission.canceled",
  "submission.published",
  "kit.published",
  "kit.hidden",
  "kit.unhidden",
  "kit.removed",
  "kit.pricing_set",
  "kit.visibility_set",
  "kit.transferred",
  "org.created",
  "org.member_added",
  "org.member_removed",
  "org.invite_accepted",
  "org.deleted",
  "entitlement.granted",
  "entitlement.revoked"
];

function buildAuditPath(filters: Filters, nextToken?: string) {
  const params = new URLSearchParams();
  if (filters.actorUserId.trim()) params.set("actorUserId", filters.actorUserId.trim());
  if (filters.action) params.set("action", filters.action);
  if (filters.targetType) params.set("targetType", filters.targetType);
  if (filters.targetId.trim()) params.set("targetId", filters.targetId.trim());
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  params.set("limit", "50");
  if (nextToken) params.set("nextToken", nextToken);
  return `/api/admin/audit-logs?${params.toString()}`;
}

async function fetchAuditLogs(
  filters: Filters,
  nextToken?: string
): Promise<{ items: AuditEvent[]; nextToken?: string }> {
  const res = await fetch(buildAuditPath(filters, nextToken));
  if (!res.ok) {
    let message = `Audit log request failed (${res.status}).`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // keep status fallback
    }
    throw new Error(message);
  }
  const payload = (await res.json()) as { items?: AuditEvent[]; nextToken?: string };
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    nextToken: payload.nextToken
  };
}

function formatTimestamp(ts: string) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return ts;
  }
}

function MetadataCell({ metadata }: { metadata?: Record<string, string | number | boolean | null> }) {
  const [expanded, setExpanded] = useState(false);
  if (!metadata || Object.keys(metadata).length === 0) return <span className="muted-text">—</span>;
  const entries = Object.entries(metadata);
  const preview = entries
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(", ");

  return (
    <span>
      <button
        type="button"
        className="secondary-link"
        style={{ fontSize: "inherit", padding: 0 }}
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        {expanded ? "hide" : preview + (entries.length > 2 ? " …" : "")}
      </button>
      {expanded && (
        <pre
          style={{
            marginTop: "4px",
            fontSize: "0.75em",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            background: "var(--color-surface-alt, #f5f5f5)",
            borderRadius: "4px",
            padding: "6px 8px"
          }}
        >
          {JSON.stringify(metadata, null, 2)}
        </pre>
      )}
    </span>
  );
}

export function AuditLogsClient() {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(emptyFilters);
  const [state, setState] = useState<LoadState>({ status: "idle" });

  // Carry the nextToken so "load more" can append
  const nextTokenRef = useRef<string | undefined>(undefined);

  const load = useCallback((f: Filters, token?: string) => {
    setState((prev) =>
      token
        ? prev.status === "loaded"
          ? { ...prev, status: "loaded" } // keep existing while appending
          : { status: "loading" }
        : { status: "loading" }
    );

    fetchAuditLogs(f, token)
      .then(({ items, nextToken }) => {
        nextTokenRef.current = nextToken;
        setState((prev) => {
          const existing = token && prev.status === "loaded" ? prev.items : [];
          return { status: "loaded", items: [...existing, ...items], nextToken };
        });
      })
      .catch((err: unknown) => {
        setState({
          status: "failed",
          message: err instanceof Error ? err.message : "Audit log failed to load."
        });
      });
  }, []);

  const applyFilters = useCallback(() => {
    nextTokenRef.current = undefined;
    setAppliedFilters(filters);
    load(filters, undefined);
  }, [filters, load]);

  const resetFilters = useCallback(() => {
    setFilters(emptyFilters);
    nextTokenRef.current = undefined;
    setAppliedFilters(emptyFilters);
    load(emptyFilters, undefined);
  }, [load]);

  const loadMore = useCallback(() => {
    load(appliedFilters, nextTokenRef.current);
  }, [appliedFilters, load]);

  // Auto-load on mount
  useEffect(() => {
    load(emptyFilters, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flow">
      {/* Filter bar */}
      <div className="filter-bar" style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "0.85em" }}>
          Actor user ID
          <Input
            style={{ minWidth: "160px" }}
            type="text"
            placeholder="user_…"
            value={filters.actorUserId}
            onChange={(e) => setFilters((f) => ({ ...f, actorUserId: e.target.value }))}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "0.85em" }}>
          Action
          <Select
            value={filters.action}
            onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
          >
            <option value="">All actions</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </Select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "0.85em" }}>
          Target type
          <Select
            value={filters.targetType}
            onChange={(e) => setFilters((f) => ({ ...f, targetType: e.target.value }))}
          >
            <option value="">All types</option>
            {TARGET_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "0.85em" }}>
          Target ID
          <Input
            style={{ minWidth: "160px" }}
            type="text"
            placeholder="target ID"
            value={filters.targetId}
            onChange={(e) => setFilters((f) => ({ ...f, targetId: e.target.value }))}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "0.85em" }}>
          Since
          <Input
            type="datetime-local"
            value={filters.since}
            onChange={(e) => setFilters((f) => ({ ...f, since: e.target.value ? new Date(e.target.value).toISOString() : "" }))}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "0.85em" }}>
          Until
          <Input
            type="datetime-local"
            value={filters.until}
            onChange={(e) => setFilters((f) => ({ ...f, until: e.target.value ? new Date(e.target.value).toISOString() : "" }))}
          />
        </label>

        <div style={{ display: "flex", gap: "8px", alignSelf: "flex-end" }}>
          <Button type="button" onClick={applyFilters}>
            Apply
          </Button>
          <Button type="button" variant="secondary" onClick={resetFilters}>
            Reset
          </Button>
        </div>
      </div>

      {/* Table */}
      {state.status === "idle" && (
        <div className="empty-state">
          <strong>Set filters and click Apply</strong>
          <p>Or reset to load the most recent events.</p>
        </div>
      )}

      {state.status === "loading" && (
        <div className="empty-state">
          <strong>Loading audit events</strong>
          <p>Fetching records from the backend.</p>
        </div>
      )}

      {state.status === "failed" && (
        <div className="empty-state danger-state">
          <strong>Failed to load audit logs</strong>
          <p>{state.message}</p>
        </div>
      )}

      {state.status === "loaded" && state.items.length === 0 && (
        <div className="empty-state">
          <strong>No events found</strong>
          <p>Try broadening your filters.</p>
        </div>
      )}

      {state.status === "loaded" && state.items.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="admin-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 12px", whiteSpace: "nowrap" }}>Timestamp</th>
                <th style={{ textAlign: "left", padding: "8px 12px", whiteSpace: "nowrap" }}>Actor</th>
                <th style={{ textAlign: "left", padding: "8px 12px", whiteSpace: "nowrap" }}>Type</th>
                <th style={{ textAlign: "left", padding: "8px 12px", whiteSpace: "nowrap" }}>Action</th>
                <th style={{ textAlign: "left", padding: "8px 12px", whiteSpace: "nowrap" }}>Target</th>
                <th style={{ textAlign: "left", padding: "8px 12px" }}>Metadata</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((event) => (
                <tr key={event.auditId} style={{ borderTop: "1px solid var(--color-border, #e5e7eb)" }}>
                  <td style={{ padding: "8px 12px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    {formatTimestamp(event.timestamp)}
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <div style={{ fontWeight: 500 }}>{event.actorEmail ?? event.actorUserId}</div>
                    {event.actorEmail && (
                      <div className="muted-text" style={{ fontSize: "0.85em" }}>{event.actorUserId}</div>
                    )}
                    <div className="muted-text" style={{ fontSize: "0.8em" }}>[{event.actorType}]</div>
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <span className="badge">{event.targetType}</span>
                  </td>
                  <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                    <code style={{ fontSize: "0.9em" }}>{event.action}</code>
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <code style={{ fontSize: "0.85em", wordBreak: "break-all" }}>{event.targetId}</code>
                    {event.orgId && (
                      <div className="muted-text" style={{ fontSize: "0.8em" }}>org: {event.orgId}</div>
                    )}
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <MetadataCell metadata={event.metadata} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {state.nextToken && (
            <div style={{ marginTop: "16px", textAlign: "center" }}>
              <Button type="button" variant="secondary" onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}

          <p className="muted-text" style={{ marginTop: "8px", fontSize: "0.8em" }}>
            Showing {state.items.length} event{state.items.length !== 1 ? "s" : ""}.
          </p>
        </div>
      )}
    </div>
  );
}
