"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge, TrustBadge } from "@/components/Badge";
import { Button } from "@agentkitforge/ui";
import { normalizeAdminSubmissionDetail, type AdminSubmissionDetail, type AdminSubmissionListItem } from "@/lib/admin-api";

type ListState =
  | { status: "loading" }
  | { status: "loaded"; items: AdminSubmissionListItem[] }
  | { status: "failed"; message: string };

type DetailState =
  | { status: "loading" }
  | { status: "loaded"; submission: AdminSubmissionDetail | null }
  | { status: "failed"; message: string };

export function UserSubmissionsList() {
  const [state, setState] = useState<ListState>({ status: "loading" });

  useEffect(() => {
    let active = true;

    fetch("/api/submissions")
      .then(readJson)
      .then((payload) => {
        if (active) {
          const items = Array.isArray(payload.items) ? (payload.items as AdminSubmissionListItem[]) : [];
          setState({ status: "loaded", items });
        }
      })
      .catch((error) => {
        if (active) {
          setState({ status: "failed", message: error instanceof Error ? error.message : "Submissions failed to load." });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div className="empty-state">
        <strong>Loading submissions</strong>
        <p>Fetching your latest validation and review statuses.</p>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="empty-state danger-state">
        <strong>Submissions unavailable</strong>
        <p>{state.message}</p>
      </div>
    );
  }

  if (state.items.length === 0) {
    return (
      <div className="empty-state">
        <strong>No submissions yet</strong>
        <p>Submit a `.agentkit.zip` package to start validation and review.</p>
        <Link className="secondary-link" href="/submit">
          Submit kit
        </Link>
      </div>
    );
  }

  return (
    <div className="table-panel">
      <div className="table-row table-head">
        <strong>Name</strong>
        <span>Status</span>
        <span>Validation</span>
        <span>Review</span>
        <span>Updated</span>
      </div>
      {state.items.map((item) => (
        <Link className="table-row table-link" href={`/submissions/${item.submissionId}`} key={item.submissionId}>
          <strong>{item.name}</strong>
          <span>
            <StatusBadge value={item.status ?? "pending"} />
          </span>
          <span>
            <StatusBadge value={item.validationStatus} />
          </span>
          <span>
            <StatusBadge value={item.reviewStatus} />
          </span>
          <span>{formatDate(item.updatedAt ?? item.createdAt)}</span>
        </Link>
      ))}
    </div>
  );
}

export function UserSubmissionDetail({ submissionId }: { submissionId: string }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [actionState, setActionState] = useState<{ status: "idle" | "running" | "success" | "failed"; message?: string }>(
    { status: "idle" }
  );

  const loadSubmission = useCallback(() => {
    let active = true;

    setState({ status: "loading" });
    fetch(`/api/submissions/${encodeURIComponent(submissionId)}`)
      .then(readJson)
      .then((payload) => {
        if (active) {
          setState({ status: "loaded", submission: normalizeAdminSubmissionDetail(payload) });
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
        <p>This submission is not available for your account.</p>
        <Link className="secondary-link" href="/submissions">
          Back to my submissions
        </Link>
      </div>
    );
  }

  return (
    <SubmissionDetailView
      actionState={actionState}
      onAction={async (action) => {
        setActionState({ status: "running", message: `${action.label}...` });

        try {
          const payload = await postUserAction(action.path);
          setActionState({ status: "success", message: successMessage(action.label, payload) });
          loadSubmission();
        } catch (error) {
          setActionState({
            status: "failed",
            message: error instanceof Error ? error.message : `${action.label} failed.`
          });
        }
      }}
      submission={state.submission}
    />
  );
}

function SubmissionDetailView({
  actionState,
  onAction,
  submission
}: {
  actionState: { status: "idle" | "running" | "success" | "failed"; message?: string };
  onAction: (action: UserAction) => Promise<void>;
  submission: AdminSubmissionDetail;
}) {
  const cancelState = cancelSubmissionActionState(submission);
  const removeListingState = removeOwnListingActionState(submission);

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
          <p>{submission.validationSummary?.message ?? statusDescription(submission)}</p>
          {submission.validationSummary?.errors?.length ? (
            <>
              <h3>What needs attention</h3>
              <ul>
                {submission.validationSummary.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
              <p className="privacy-note">Fix the package issue, then submit a revised `.agentkit.zip` with a new version.</p>
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
          <h2>Submission controls</h2>
          <p>
            You can cancel an active submission before review completes. Published listings use listing removal instead of
            submission cancellation.
          </p>
          <div className="hero-actions">
            <UserActionButton
              action={{
                label: "Cancel submission",
                path: `/api/submissions/${submission.submissionId}/cancel`,
                confirm: "Cancel this submission? It will leave the active review queue."
              }}
              actionState={actionState}
              state={cancelState}
              onAction={onAction}
            />
            <UserActionButton
              action={{
                label: "Remove listing",
                path: `/api/kits/${encodeURIComponent(submission.kitId ?? "")}/remove`,
                confirm: "Remove your published listing from the public catalog?"
              }}
              actionState={actionState}
              state={removeListingState}
              onAction={onAction}
            />
          </div>
          <ActionFeedback actionState={actionState} />
          <ActionReason label="Cancel submission" state={cancelState} />
          <ActionReason label="Remove listing" state={removeListingState} />
        </div>
      </div>

      <aside className="detail-sidebar">
        <div className="sidebar-card">
          <span className="section-label">Status</span>
          <StatusBadge value={submission.status ?? "pending"} />
          <span>{statusDescription(submission)}</span>
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
          <span className="section-label">Trust badges</span>
          <div className="badge-row">
            {submission.trustBadges.length > 0 ? (
              submission.trustBadges.map((badge) => <TrustBadge key={badge} status={badge} />)
            ) : (
              <Badge>Pending</Badge>
            )}
          </div>
        </div>
        {submission.status === "published" && submission.kitSlug ? (
          <div className="sidebar-card">
            <span className="section-label">Public listing</span>
            <Link className="secondary-link" href={`/kits/${submission.kitSlug}`}>
              View published kit
            </Link>
          </div>
        ) : null}
        <p className="privacy-note">Raw package contents, full prompt text, skill markdown, logs, and file trees are not shown.</p>
      </aside>
    </div>
  );
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

type UserAction = {
  label: string;
  path: string;
  confirm?: string;
};

type UserActionState = {
  enabled: boolean;
  reason?: string;
};

function UserActionButton({
  action,
  actionState,
  onAction,
  state
}: {
  action: UserAction;
  actionState: { status: "idle" | "running" | "success" | "failed"; message?: string };
  onAction: (action: UserAction) => Promise<void>;
  state: UserActionState;
}) {
  const disabled = !state.enabled || actionState.status === "running";
  const variant = action.label === "Remove listing" ? "danger" : "secondary";

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

function ActionReason({ label, state }: { label: string; state: UserActionState }) {
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

async function postUserAction(path: string) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const json = (await response.json()) as unknown;

  if (!response.ok) {
    const message = isRecord(json) && typeof json.message === "string" ? json.message : userActionError(response.status);
    throw new Error(message);
  }

  return isRecord(json) ? json : {};
}

function successMessage(actionLabel: string, payload: Record<string, unknown>) {
  return typeof payload.message === "string" ? payload.message : `${actionLabel} completed.`;
}

function cancelSubmissionActionState(submission: AdminSubmissionListItem): UserActionState {
  const status = normalizeStatus(submission.status);
  const review = normalizeStatus(submission.reviewStatus);

  if (["published", "archived", "canceled", "removed"].includes(status)) {
    return { enabled: false, reason: "Closed or published submissions cannot be canceled here." };
  }

  if (review === "approved" || review === "rejected") {
    return { enabled: false, reason: "Reviewed submissions can no longer be canceled." };
  }

  return { enabled: true };
}

function removeOwnListingActionState(submission: AdminSubmissionListItem): UserActionState {
  if (!submission.kitId) {
    return { enabled: false, reason: "No published listing is linked to this submission yet." };
  }

  if (normalizeStatus(submission.status) !== "published") {
    return { enabled: false, reason: "Only published listings can be removed." };
  }

  if (normalizeStatus(submission.kitStatus) === "removed" || Boolean(submission.removedAt)) {
    return { enabled: false, reason: "Listing has already been removed." };
  }

  return { enabled: true };
}

function userActionError(status: number) {
  if (status === 403 || status === 404) {
    return "This action is not available for this submission.";
  }

  if (status === 409) {
    return "This submission can no longer be changed from this page.";
  }

  if (status === 502) {
    return "Market backend is temporarily unavailable.";
  }

  return `Request failed with ${status}.`;
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

function statusDescription(submission: AdminSubmissionListItem) {
  const status = normalizeStatus(submission.status);
  const validation = normalizeStatus(submission.validationStatus);
  const review = normalizeStatus(submission.reviewStatus);

  if (status === "published") {
    return "Your kit has been approved and published.";
  }

  if (status === "canceled") {
    return "You canceled this submission. It is no longer in the active review queue.";
  }

  if (status === "removed") {
    return "The public listing was removed. Submission history remains available here.";
  }

  if (status === "archived") {
    return "This submission has been archived by the review team.";
  }

  if (review === "rejected") {
    return "Review did not approve this submission. Check notes and validation feedback before resubmitting.";
  }

  if (validation === "failed") {
    return "Validation found issues that need to be fixed before review.";
  }

  if (validation === "passed" && review === "approved") {
    return "Approved and waiting for an admin to publish.";
  }

  if (validation === "passed") {
    return "Validation passed and the submission is waiting for admin review.";
  }

  if (validation === "running" || validation === "queued" || status === "validating" || status === "validation_queued") {
    return "Validation is running. This can take a little while after upload.";
  }

  if (status === "awaiting_upload") {
    return "Waiting for the package upload to finish.";
  }

  return "Submitted and waiting for validation or review updates.";
}

function StatusBadge({ value }: { value: string }) {
  const normalized = normalizeStatus(value);
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

function normalizeStatus(value?: string) {
  return value?.trim().toLowerCase() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
