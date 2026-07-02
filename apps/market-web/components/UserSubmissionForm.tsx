"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input, Textarea } from "@agentkitforge/ui";
import {
  buildUserCreateUploadUrlRequest,
  resolveSubmissionConflictMessage,
  validateUserCreateUploadUrlRequest
} from "@/lib/user-upload";

type SubmitState =
  | { status: "idle" }
  | { status: "uploading"; message: string }
  | { status: "failed"; message: string };

const initialState: SubmitState = { status: "idle" };

export function UserSubmissionForm({ isConfigured }: { isConfigured: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<SubmitState>(initialState);

  async function onSubmit(formData: FormData) {
    const file = formData.get("packageFile");

    if (!(file instanceof File)) {
      setState({ status: "failed", message: "Select a .agentkit.zip package." });
      return;
    }

    if (!file.name.endsWith(".agentkit.zip")) {
      setState({ status: "failed", message: "Package must be a .agentkit.zip file." });
      return;
    }

    const payload = buildUserCreateUploadUrlRequest({
      name: stringValue(formData, "name"),
      summary: stringValue(formData, "summary"),
      description: stringValue(formData, "description"),
      version: stringValue(formData, "version"),
      categories: stringValue(formData, "categories"),
      tags: stringValue(formData, "tags"),
      fileName: file.name
    });
    const validationError = validateUserCreateUploadUrlRequest(payload);

    if (validationError) {
      setState({ status: "failed", message: validationError });
      return;
    }

    setState({ status: "uploading", message: "Requesting secure upload URL..." });

    try {
      const uploadUrlResponse = await postJson("/api/submissions/upload-url", payload);
      const uploadUrl = requiredString(uploadUrlResponse.uploadUrl, "uploadUrl");
      const submissionId = requiredString(uploadUrlResponse.submissionId, "submissionId");

      setState({ status: "uploading", message: "Uploading package..." });
      await uploadPackage(uploadUrlResponse, uploadUrl, file);

      setState({ status: "uploading", message: "Starting validation..." });
      await postJson(`/api/submissions/${encodeURIComponent(submissionId)}/validate`, {});

      router.push(`/submissions/${encodeURIComponent(submissionId)}`);
    } catch (error) {
      if (error instanceof SubmissionConflictError) {
        setState({ status: "failed", message: error.message });
        return;
      }

      setState({ status: "failed", message: error instanceof Error ? error.message : "Submission failed." });
    }
  }

  if (!isConfigured) {
    return (
      <div className="empty-state">
        <strong>Submission system unavailable</strong>
        <p>Server submission configuration is incomplete. Please try again after Market support updates the deployment.</p>
      </div>
    );
  }

  return (
    <form className="form-panel" action={onSubmit}>
      <Input label="Kit name" name="name" required placeholder="Research Brief Builder" />
      <Textarea label="Summary" name="summary" required placeholder="Short public-safe listing summary." />
      <Textarea label="Description" name="description" placeholder="Longer public-safe detail description." />
      <div className="form-grid">
        <Input label="Version" name="version" required placeholder="0.1.0" />
        <Input label="Package" name="packageFile" type="file" required accept=".zip,.agentkit.zip,application/zip" />
      </div>
      <div className="form-grid">
        <Input label="Categories" name="categories" placeholder="Research, Writing" />
        <Input label="Tags" name="tags" placeholder="Briefing, Knowledge work" />
      </div>
      <div className="rule-callout">
        <strong>Public-safe submission</strong>
        <span>
          Validation may extract summaries for review, but raw package contents are not shown in Market UI. Market generates
          the public kit URL after approval and publish.
        </span>
      </div>
      <Button type="submit" disabled={state.status === "uploading"}>
        {state.status === "uploading" ? "Submitting..." : "Submit for validation"}
      </Button>
      <SubmitStatus state={state} />
    </form>
  );
}

function SubmitStatus({ state }: { state: SubmitState }) {
  if (state.status === "idle") {
    return null;
  }

  return (
    <div className={state.status === "failed" ? "empty-state danger-state" : "empty-state"}>
      <strong>{state.status === "failed" ? "Submission failed" : "Submission in progress"}</strong>
      <p>{state.message}</p>
      {state.status === "failed" && state.message.includes("active submission") ? (
        <Link className="secondary-link" href="/submissions">
          View my submissions
        </Link>
      ) : null}
    </div>
  );
}

async function uploadPackage(uploadResponse: Record<string, unknown>, uploadUrl: string, file: File) {
  const method = uploadResponse.method === "POST" ? "POST" : "PUT";

  if (method === "POST" && isStringRecord(uploadResponse.fields)) {
    const formData = new FormData();

    Object.entries(uploadResponse.fields).forEach(([key, value]) => {
      formData.append(key, value);
    });
    formData.append("file", file);

    const response = await fetch(uploadUrl, { method: "POST", body: formData });
    throwIfUploadFailed(response);
    return;
  }

  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: isStringRecord(uploadResponse.headers) ? uploadResponse.headers : { "Content-Type": "application/zip" }
  });
  throwIfUploadFailed(response);
}

function throwIfUploadFailed(response: Response) {
  if (!response.ok) {
    throw new Error(`Package upload failed with status ${response.status}.`);
  }
}

async function postJson(path: string, payload: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const json = (await response.json()) as unknown;

  if (!response.ok) {
    const serverMessage = isObject(json) && typeof json.message === "string" ? json.message : null;
    if (response.status === 409) {
      throw new SubmissionConflictError(serverMessage);
    }

    throw new Error(serverMessage ?? `Request failed with ${response.status}.`);
  }

  return isObject(json) ? json : {};
}

class SubmissionConflictError extends Error {
  constructor(serverMessage: string | null) {
    // A duplicate-submission conflict keeps the friendly copy; any other 409
    // (e.g. missing AgentKitProfile display name) surfaces the server message.
    super(resolveSubmissionConflictMessage(serverMessage));
    this.name = "SubmissionConflictError";
  }
}

function stringValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Upload response is missing ${label}.`);
  }

  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}
