"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { normalizeAdminSubmissionDetail, type AdminSubmissionDetail, type AdminSubmissionListItem } from "@/lib/admin-api";
import {
  approveActionState,
  hideKitActionState,
  isArchived,
  publishActionState,
  rejectActionState,
  removeListingActionState,
  removeSubmissionActionState,
  reviewSectionFor,
  unhideKitActionState,
  type ReviewSectionKey
} from "@/lib/admin-actions";
import { Badge, TrustBadge } from "@/components/Badge";
import { Button, Input, Select, Textarea } from "@agentkitforge/ui";

type ListState =
  | { status: "loading" }
  | { status: "loaded"; items: AdminSubmissionListItem[] }
  | { status: "failed"; message: string };

type DetailState =
  | { status: "loading" }
  | { status: "loaded"; submission: AdminSubmissionDetail | null }
  | { status: "failed"; message: string };

const reviewSections: Array<{ key: ReviewSectionKey; title: string; summary: string }> = [
  { key: "pending-validation", title: "Needs validation", summary: "Uploaded or queued submissions waiting on validation." },
  { key: "validation-failed", title: "Validation failed", summary: "Submissions that need fixes before review." },
  { key: "ready-for-review", title: "Ready for approval", summary: "Validated submissions waiting for an admin decision." },
  { key: "approved", title: "Approved, ready to publish", summary: "Reviewed submissions that can be published." },
  { key: "published", title: "Published", summary: "Submissions already visible through the public catalog API." },
  { key: "rejected", title: "Rejected", summary: "Submissions rejected during review." },
  { key: "archived", title: "History", summary: "Archived, canceled, removed, or expired records kept out of the default queue." }
];

export function AdminSubmissionsList({ reviewMode = false }: { reviewMode?: boolean }) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [filters, setFilters] = useState({
    status: "",
    validationStatus: "",
    reviewStatus: "",
    includeArchived: reviewMode,
    submittedByEmail: ""
  });

  useEffect(() => {
    let active = true;

    fetch(adminSubmissionsPath(filters))
      .then(readJson)
      .then((payload) => {
        if (active) {
          const items = Array.isArray(payload.items) ? (payload.items as AdminSubmissionListItem[]) : [];
          setState({ status: "loaded", items });
        }
      })
      .catch((error) => {
        if (active) {
          setState({ status: "failed", message: error instanceof Error ? error.message : "Submission queue failed to load." });
        }
      });

    return () => {
      active = false;
    };
  }, [filters]);

  if (state.status === "loading") {
    return (
      <div className="empty-state">
        <strong>Loading submissions</strong>
        <p>Fetching the latest validation and review statuses.</p>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="empty-state danger-state">
        <strong>Backend unavailable</strong>
        <p>{state.message}</p>
      </div>
    );
  }

  if (state.items.length === 0) {
    return (
      <div className="empty-state">
        <strong>No submissions yet</strong>
        <p>Upload a `.agentkit.zip` package to create the first validation submission.</p>
        <Link className="secondary-link" href="/admin/upload">
          Start upload
        </Link>
      </div>
    );
  }

  const filteredItems = filterItems(state.items, filters);
  const groupedItems = groupItems(filteredItems);

  if (reviewMode) {
    return (
      <div className="review-stack">
        <SubmissionFilters filters={filters} reviewMode={reviewMode} setFilters={setFilters} />
        {reviewSections.map((section) => (
          <SubmissionSection
            items={groupedItems[section.key]}
            key={section.key}
            summary={section.summary}
            title={section.title}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="review-stack">
      <SubmissionFilters filters={filters} reviewMode={reviewMode} setFilters={setFilters} />
      {filteredItems.length > 0 ? (
        <SubmissionTable items={filteredItems} />
      ) : (
        <div className="empty-state">
          <strong>No matching submissions</strong>
          <p>Try clearing a filter or including history.</p>
        </div>
      )}
    </div>
  );
}

export function AdminSubmissionDetail({ submissionId }: { submissionId: string }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [reviewNotes, setReviewNotes] = useState("");
  const [actionState, setActionState] = useState<{ status: "idle" | "running" | "success" | "failed"; message?: string }>(
    { status: "idle" }
  );

  const loadSubmission = useCallback(() => {
    let active = true;

    setState({ status: "loading" });
    fetch(`/api/admin/submissions/${encodeURIComponent(submissionId)}`)
      .then(readJson)
      .then((payload) => {
        if (active) {
          const submission = normalizeAdminSubmissionDetail(payload);
          setState({ status: "loaded", submission });
          setReviewNotes(submission.reviewNotes ?? "");
        }
      })
      .catch((error) => {
        if (active) {
          if (error instanceof ClientApiError && error.status === 404) {
            setState({ status: "loaded", submission: null });
            return;
          }

          setState({ status: "failed", message: error instanceof Error ? error.message : "Submission detail failed to load." });
        }
      });

    return () => {
      active = false;
    };
  }, [submissionId]);

  useEffect(() => loadSubmission(), [loadSubmission]);

  if (state.status === "loading") {
    return (
      <div className="empty-state">
        <strong>Loading submission</strong>
        <p>Fetching validation status and public-safe metadata.</p>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="empty-state danger-state">
        <strong>Submission unavailable</strong>
        <p>{state.message}</p>
      </div>
    );
  }

  if (!state.submission) {
    return (
      <div className="empty-state">
        <strong>Submission not found</strong>
        <p>This submission is not available in the admin queue.</p>
      </div>
    );
  }

  return (
    <SubmissionDetailView
      actionState={actionState}
      onAction={async (action) => {
        setActionState({ status: "running", message: `${action.label}...` });

        try {
          const payload = await action.run(reviewNotes);
          setActionState({ status: "success", message: successMessage(action.label, payload) });
          loadSubmission();
        } catch (error) {
          setActionState({
            status: "failed",
            message: error instanceof Error ? error.message : `${action.label} failed.`
          });
        }
      }}
      reviewNotes={reviewNotes}
      setReviewNotes={setReviewNotes}
      submission={state.submission}
    />
  );
}

function SubmissionDetailView({
  actionState,
  onAction,
  reviewNotes,
  setReviewNotes,
  submission
}: {
  actionState: { status: "idle" | "running" | "success" | "failed"; message?: string };
  onAction: (action: AdminAction) => Promise<void>;
  reviewNotes: string;
  setReviewNotes: (value: string) => void;
  submission: AdminSubmissionDetail;
}) {
  const approveState = approveActionState(submission);
  const rejectState = rejectActionState(submission, reviewNotes);
  const publishState = publishActionState(submission);
  const removeSubmissionState = removeSubmissionActionState(submission);
  const hideState = hideKitActionState(submission);
  const unhideState = unhideKitActionState(submission);
  const removeListingState = removeListingActionState(submission);
  const publishedSlug = submission.kitSlug;

  return (
    <div className="detail-layout">
      <div className="detail-main">
        <div className="detail-panel">
          <h2>Listing draft</h2>
          <p>{submission.summary ?? "No public summary provided yet."}</p>
          {submission.description ? <p>{submission.description}</p> : null}
          <div className="chip-row">
            {submission.categories.map((category) => (
              <Badge key={category}>{category}</Badge>
            ))}
            {submission.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        </div>

        <div className="detail-panel">
          <h2>Validation summary</h2>
          <p>{submission.validationSummary?.message ?? "Validation summary is not available yet."}</p>
          {submission.validationSummary?.errors?.length ? (
            <>
              <h3>Errors</h3>
              <ul>
                {submission.validationSummary.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </>
          ) : null}
          {submission.validationSummary?.warnings?.length ? (
            <>
              <h3>Warnings</h3>
              <ul>
                {submission.validationSummary.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </>
          ) : null}
          {submission.validationSummary?.checks?.length ? (
            <ul>
              {submission.validationSummary.checks.map((check) => (
                <li key={`${check.name}-${check.status}`}>
                  <strong>{check.name}</strong>: {check.status}
                  {check.summary ? ` - ${check.summary}` : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <PublicSafeSummary title="Required input summaries" items={submission.requiredInputs} />
        <PublicSafeSummary title="Prepared prompt summaries" items={submission.preparedPrompts} />
        <PublicSafeSummary title="Skill summaries" items={submission.skills} />

        <div className="detail-panel">
          <h2>Review decision</h2>
          <Textarea
            label="Review notes"
            placeholder="Reason for approval or rejection. Required for rejection."
            value={reviewNotes}
            onChange={(event) => setReviewNotes(event.target.value)}
          />
          <div className="hero-actions">
            <ActionButton
              action={{
                label: "Approve",
                run: (notes) => postAdminAction(`/api/admin/submissions/${submission.submissionId}/approve`, { reviewNotes: notes })
              }}
              actionState={actionState}
              state={approveState}
              onAction={onAction}
            />
            <ActionButton
              action={{
                label: "Reject",
                confirm: "Reject this submission? The submitter will need to revise and resubmit.",
                run: (notes) => postAdminAction(`/api/admin/submissions/${submission.submissionId}/reject`, { reviewNotes: notes })
              }}
              actionState={actionState}
              state={rejectState}
              onAction={onAction}
            />
            <ActionButton
              action={{
                label: "Publish",
                confirm: "Publish this kit to the public catalog?",
                run: () => postAdminAction(`/api/admin/submissions/${submission.submissionId}/publish`, {})
              }}
              actionState={actionState}
              state={publishState}
              onAction={onAction}
            />
            <ActionButton
              action={{
                label: "Remove submission",
                confirm: "Remove this submission from the active queue? It will remain in admin history.",
                run: () => postAdminAction(`/api/admin/submissions/${submission.submissionId}/remove`, {})
              }}
              actionState={actionState}
              state={removeSubmissionState}
              onAction={onAction}
            />
            <ActionButton
              action={{
                label: "Hide kit",
                confirm: "Hide this kit from the public catalog? Submission history will remain available to admins.",
                run: () => postAdminAction(`/api/admin/kits/${encodeURIComponent(submission.kitId ?? "")}/hide`, {})
              }}
              actionState={actionState}
              state={hideState}
              onAction={onAction}
            />
            <ActionButton
              action={{
                label: "Unhide kit",
                confirm: "Restore this kit to the public catalog if it still passes the public listing gate?",
                run: () => postAdminAction(`/api/admin/kits/${encodeURIComponent(submission.kitId ?? "")}/unhide`, {})
              }}
              actionState={actionState}
              state={unhideState}
              onAction={onAction}
            />
            <ActionButton
              action={{
                label: "Remove listing",
                confirm: "Remove this published listing from the public catalog? This is a visibility-changing action.",
                run: () => postAdminAction(`/api/admin/kits/${encodeURIComponent(submission.kitId ?? "")}/remove`, {})
              }}
              actionState={actionState}
              state={removeListingState}
              onAction={onAction}
            />
          </div>
          <p className="privacy-note">
            Remove submission closes an active queue item. Hide, unhide, and remove listing change public kit visibility without exposing package internals.
          </p>
          <ActionFeedback actionState={actionState} />
          <ActionReason label="Approve" state={approveState} />
          <ActionReason label="Reject" state={rejectState} />
          <ActionReason label="Publish" state={publishState} />
          <ActionReason label="Remove submission" state={removeSubmissionState} />
          <ActionReason label="Hide" state={hideState} />
          <ActionReason label="Unhide" state={unhideState} />
          <ActionReason label="Remove listing" state={removeListingState} />
          {publishedSlug ? (
            <Link className="secondary-link" href={`/kits/${publishedSlug}`}>
              View public kit
            </Link>
          ) : null}
        </div>
      </div>

      <aside className="detail-sidebar">
        <div className="sidebar-card">
          <span className="section-label">Status</span>
          <StatusBadge value={submission.status ?? "pending"} />
          {submission.archivedAt ? <span>Archived {formatDate(submission.archivedAt)}</span> : null}
          {submission.canceledAt ? <span>Canceled {formatDate(submission.canceledAt)}</span> : null}
          {submission.removedAt ? <span>Removed {formatDate(submission.removedAt)}</span> : null}
        </div>
        <div className="sidebar-card">
          <span className="section-label">Validation</span>
          <StatusBadge value={submission.validationStatus} />
        </div>
        <div className="sidebar-card">
          <span className="section-label">Review</span>
          <StatusBadge value={submission.reviewStatus} />
        </div>
        <div className="sidebar-card">
          <span className="section-label">Version</span>
          <strong>{submission.version ?? "Pending"}</strong>
        </div>
        <div className="sidebar-card">
          <span className="section-label">Publisher</span>
          <strong>{submission.publisherName ?? submission.publisherId ?? "Unknown publisher"}</strong>
        </div>
        <div className="sidebar-card">
          <span className="section-label">Submitter</span>
          <strong>{submission.submittedByEmail ?? "Unknown submitter"}</strong>
          {submission.submittedByUserId ? <span>{submission.submittedByUserId}</span> : null}
        </div>
        <div className="sidebar-card">
          <span className="section-label">Review</span>
          <strong>{submission.reviewStatus}</strong>
          {submission.reviewedAt ? <span>{formatDate(submission.reviewedAt)}</span> : null}
          {submission.reviewNotes ? <p>{submission.reviewNotes}</p> : null}
        </div>
        <div className="sidebar-card">
          <span className="section-label">Publish</span>
          <StatusBadge value={submission.status ?? "pending"} />
          {submission.publishedAt ? <span>{formatDate(submission.publishedAt)}</span> : null}
          {submission.kitStatus ? <span>Kit: {submission.kitStatus}</span> : null}
          {submission.hiddenAt ? <span>Hidden {formatDate(submission.hiddenAt)}</span> : null}
          {submission.removedAt ? <span>Removed {formatDate(submission.removedAt)}</span> : null}
          {submission.kitId ? <span>{submission.kitId}</span> : null}
          {submission.kitSlug ? <span>{submission.kitSlug}</span> : null}
        </div>
        <div className="sidebar-card">
          <span className="section-label">Downloads</span>
          <strong>{(submission.kitDownloads ?? 0).toLocaleString()}</strong>
        </div>
        {submission.packageS3Key ? (
          <div className="sidebar-card">
            <span className="section-label">Package key</span>
            <strong>{submission.packageS3Key}</strong>
          </div>
        ) : null}
        <div className="sidebar-card">
          <span className="section-label">Trust badges</span>
          <div className="badge-row">
            {submission.trustBadges.length > 0 ? (
              submission.trustBadges.map((badge) => <TrustBadge key={badge} status={badge} />)
            ) : (
              <Badge>Pending</Badge>
            )}
          </div>
        </div>
        <p className="privacy-note">Raw package contents, full prompt text, skill markdown, logs, and file trees are not shown.</p>
      </aside>
    </div>
  );
}

type AdminAction = {
  label: string;
  confirm?: string;
  run: (reviewNotes: string) => Promise<Record<string, unknown>>;
};

type Filters = {
  status: string;
  validationStatus: string;
  reviewStatus: string;
  includeArchived: boolean;
  submittedByEmail: string;
};

function SubmissionFilters({
  filters,
  reviewMode,
  setFilters
}: {
  filters: Filters;
  reviewMode: boolean;
  setFilters: (filters: Filters) => void;
}) {
  return (
    <div className="detail-panel">
      <div className="section-heading">
        <p className="eyebrow">Filters</p>
        <h2>{reviewMode ? "Review queue filters" : "Submission queue filters"}</h2>
      </div>
      <div className="form-grid">
        <Select
          label="Status"
          value={filters.status}
          onChange={(event) => setFilters({ ...filters, status: event.target.value })}
        >
          <option value="">Any status</option>
          <option value="awaiting_upload">Awaiting upload</option>
          <option value="uploaded">Uploaded</option>
          <option value="validating">Validating</option>
          <option value="validated">Validated</option>
          <option value="validation_queued">Validation queued</option>
          <option value="validation_passed">Validation passed</option>
          <option value="validation_failed">Validation failed</option>
          <option value="published">Published</option>
          <option value="hidden">Hidden</option>
          <option value="rejected">Rejected</option>
          <option value="archived">Archived</option>
          <option value="canceled">Canceled</option>
          <option value="removed">Removed</option>
        </Select>
        <Select
          label="Validation"
          value={filters.validationStatus}
          onChange={(event) => setFilters({ ...filters, validationStatus: event.target.value })}
        >
          <option value="">Any validation status</option>
          <option value="pending">Pending</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="passed">Passed</option>
          <option value="failed">Failed</option>
        </Select>
      </div>
      <div className="form-grid">
        <Select
          label="Review"
          value={filters.reviewStatus}
          onChange={(event) => setFilters({ ...filters, reviewStatus: event.target.value })}
        >
          <option value="">Any review status</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </Select>
        <Input
          label="Submitter email"
          placeholder="name@example.com"
          value={filters.submittedByEmail}
          onChange={(event) => setFilters({ ...filters, submittedByEmail: event.target.value })}
        />
      </div>
      <label className="checkbox-row">
        <input
          checked={filters.includeArchived}
          type="checkbox"
          onChange={(event) => setFilters({ ...filters, includeArchived: event.target.checked })}
        />
        Include history
      </label>
    </div>
  );
}

function SubmissionSection({
  items,
  summary,
  title
}: {
  items: AdminSubmissionListItem[];
  summary: string;
  title: string;
}) {
  return (
    <div className="detail-panel">
      <div className="section-heading">
        <p className="eyebrow">{title}</p>
        <h2>{items.length} submissions</h2>
        <p>{summary}</p>
      </div>
      {items.length > 0 ? <SubmissionTable items={items} /> : <p>No submissions in this section.</p>}
    </div>
  );
}

function SubmissionTable({ items }: { items: AdminSubmissionListItem[] }) {
  return (
    <div className="table-panel admin-table">
      <div className="table-row table-head">
        <strong>Name</strong>
        <span>Submitter</span>
        <span>Version</span>
        <span>Downloads</span>
        <span>Validation</span>
        <span>Review</span>
        <span>Status</span>
        <span>Created</span>
        <span>Updated</span>
      </div>
      {items.map((item) => (
        <Link className="table-row table-link" href={`/admin/submissions/${item.submissionId}`} key={item.submissionId}>
          <strong>{item.name}</strong>
          <span>{item.submittedByEmail ?? item.publisherName ?? item.publisherId ?? "Unknown"}</span>
          <span>{item.version ?? "Pending"}</span>
          <span>{(item.kitDownloads ?? 0).toLocaleString()}</span>
          <span>
            <StatusBadge value={item.validationStatus} />
          </span>
          <span>
            <StatusBadge value={item.reviewStatus} />
          </span>
          <span>
            <StatusBadge value={item.status ?? "pending"} />
          </span>
          <span>{formatDate(item.createdAt)}</span>
          <span>{formatDate(item.updatedAt)}</span>
        </Link>
      ))}
    </div>
  );
}

function ActionButton({
  action,
  actionState,
  onAction,
  state
}: {
  action: AdminAction;
  actionState: { status: "idle" | "running" | "success" | "failed"; message?: string };
  onAction: (action: AdminAction) => Promise<void>;
  state: { enabled: boolean; reason?: string };
}) {
  const disabled = !state.enabled || actionState.status === "running";
  const variant = adminActionVariant(action.label);

  return (
    <Button
      variant={variant}
      disabled={disabled}
      type="button"
      onClick={() => {
        if (action.confirm && !window.confirm(action.confirm)) {
          return;
        }

        void onAction(action);
      }}
    >
      {actionState.status === "running" ? "Working..." : action.label}
    </Button>
  );
}

function adminActionVariant(label: string): "primary" | "secondary" | "danger" {
  if (label === "Approve" || label === "Publish") {
    return "primary";
  }

  if (label === "Reject" || label === "Remove submission" || label === "Remove listing") {
    return "danger";
  }

  return "secondary";
}

function ActionReason({ label, state }: { label: string; state: { enabled: boolean; reason?: string } }) {
  if (state.enabled || !state.reason) {
    return null;
  }

  return (
    <p className="privacy-note">
      <strong>{label} disabled:</strong> {state.reason}
    </p>
  );
}

function ActionFeedback({
  actionState
}: {
  actionState: { status: "idle" | "running" | "success" | "failed"; message?: string };
}) {
  if (actionState.status === "idle") {
    return null;
  }

  return (
    <div className={actionState.status === "failed" ? "empty-state danger-state" : "empty-state"}>
      <strong>{actionState.status === "failed" ? "Action failed" : "Action status"}</strong>
      <p>{actionState.message}</p>
    </div>
  );
}

async function postAdminAction(path: string, payload: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const json = (await response.json()) as unknown;

  if (!response.ok) {
    const message = isRecord(json) && typeof json.message === "string" ? json.message : `Request failed with ${response.status}.`;
    throw new Error(message);
  }

  return isRecord(json) ? json : {};
}

function adminSubmissionsPath(filters: Filters) {
  const query = new URLSearchParams();

  if (filters.status) {
    query.set("status", filters.status);
  }

  if (filters.validationStatus) {
    query.set("validationStatus", filters.validationStatus);
  }

  if (filters.reviewStatus) {
    query.set("reviewStatus", filters.reviewStatus);
  }

  const submittedByEmail = filters.submittedByEmail.trim();
  if (submittedByEmail) {
    query.set("submittedByEmail", submittedByEmail);
  }

  if (filters.includeArchived) {
    query.set("includeHistory", "true");
  }

  const queryString = query.toString();
  return `/api/admin/submissions${queryString ? `?${queryString}` : ""}`;
}

function successMessage(actionLabel: string, payload: Record<string, unknown>) {
  return typeof payload.message === "string" ? payload.message : `${actionLabel} completed.`;
}

function groupItems(items: AdminSubmissionListItem[]) {
  const groups: Record<ReviewSectionKey, AdminSubmissionListItem[]> = {
    "pending-validation": [],
    "validation-failed": [],
    "ready-for-review": [],
    approved: [],
    rejected: [],
    published: [],
    archived: []
  };

  items.forEach((item) => {
    groups[reviewSectionFor(item)].push(item);
  });

  return groups;
}

function filterItems(items: AdminSubmissionListItem[], filters: Filters) {
  const submittedByEmail = filters.submittedByEmail.trim().toLowerCase();

  return items.filter((item) => {
    if (!filters.includeArchived && isArchived(item)) {
      return false;
    }

    if (filters.status && !matchesStatus(item.status, filters.status)) {
      return false;
    }

    if (filters.validationStatus && !matchesStatus(item.validationStatus, filters.validationStatus)) {
      return false;
    }

    if (filters.reviewStatus && !matchesStatus(item.reviewStatus, filters.reviewStatus)) {
      return false;
    }

    if (submittedByEmail && !(item.submittedByEmail ?? "").toLowerCase().includes(submittedByEmail)) {
      return false;
    }

    return true;
  });
}

function matchesStatus(value: string | undefined, expected: string) {
  return value?.trim().toLowerCase() === expected;
}

function StatusBadge({ value }: { value: string }) {
  const normalized = value.trim().toLowerCase();
  const positive = ["passed", "approved", "published", "validated", "validation_passed"];
  const warning = ["pending", "queued", "running", "validating", "awaiting_upload", "uploaded", "validation_queued"];
  const danger = ["failed", "rejected", "validation_failed"];
  const className = positive.includes(normalized)
    ? "badge badge-success"
    : warning.includes(normalized)
      ? "badge badge-warning"
      : danger.includes(normalized)
        ? "badge badge-danger"
        : "badge badge-muted";

  return <span className={className}>{value}</span>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function PublicSafeSummary({
  title,
  items
}: {
  title: string;
  items: Array<{ name: string; summary?: string }>;
}) {
  return (
    <div className="detail-panel">
      <h2>{title}</h2>
      <p className="privacy-note">Only public-safe summaries are shown.</p>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item.name}>
              <strong>{item.name}</strong>
              {item.summary ? `: ${item.summary}` : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>No public-safe summaries available yet.</p>
      )}
    </div>
  );
}

async function readJson(response: Response) {
  const payload = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    throw new ClientApiError(
      typeof payload.message === "string" ? payload.message : `Request failed with ${response.status}.`,
      response.status
    );
  }

  return payload;
}

class ClientApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ClientApiError";
  }
}

function formatDate(value?: string) {
  if (!value) {
    return "Pending";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}
