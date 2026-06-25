"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Input, Textarea } from "@agentkitforge/ui";
import { buildAdminCreateUploadUrlRequest, validateAdminCreateUploadUrlRequest } from "@/lib/admin-upload";

type UploadState =
  | { status: "idle" }
  | { status: "uploading"; message: string }
  | { status: "queued"; submissionId: string; message: string }
  | { status: "failed"; message: string };

const initialState: UploadState = { status: "idle" };

export function AdminUploadForm({ isConfigured }: { isConfigured: boolean }) {
  const [state, setState] = useState<UploadState>(initialState);

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

    const payload = buildAdminCreateUploadUrlRequest({
      name: stringValue(formData, "name"),
      summary: stringValue(formData, "summary"),
      description: stringValue(formData, "description"),
      version: stringValue(formData, "version"),
      publisherId: stringValue(formData, "publisherId"),
      categories: stringValue(formData, "categories"),
      tags: stringValue(formData, "tags"),
      fileName: file.name
    });
    const validationError = validateAdminCreateUploadUrlRequest(payload);

    if (validationError) {
      setState({ status: "failed", message: validationError });
      return;
    }

    setState({ status: "uploading", message: "Requesting secure upload URL..." });

    try {
      const uploadUrlResponse = await postJson("/api/admin/submissions/upload-url", payload);

      const uploadUrl = requiredString(uploadUrlResponse.uploadUrl, "uploadUrl");
      const submissionId = requiredString(uploadUrlResponse.submissionId, "submissionId");

      setState({ status: "uploading", message: "Uploading package..." });
      await uploadPackage(uploadUrlResponse, uploadUrl, file);

      setState({ status: "uploading", message: "Starting validation..." });
      await postJson(`/api/admin/submissions/${encodeURIComponent(submissionId)}/validate`, {});

      setState({
        status: "queued",
        submissionId,
        message: "Validation queued. The package is uploaded and ready for review once validation completes."
      });
    } catch (error) {
      setState({ status: "failed", message: error instanceof Error ? error.message : "Upload failed." });
    }
  }

  if (!isConfigured) {
    return (
      <div className="empty-state">
        <strong>Missing admin config</strong>
        <p>Server admin API configuration is incomplete. Check the deployment environment variables to enable admin upload.</p>
      </div>
    );
  }

  return (
    <form className="form-panel" action={onSubmit}>
      <Input label="Kit name" name="name" required placeholder="Sales Report Generator" />
      <Textarea label="Summary" name="summary" required placeholder="Short public-safe listing summary." />
      <Textarea label="Description" name="description" placeholder="Longer public-safe detail description." />
      <div className="form-grid">
        <Input label="Version" name="version" required placeholder="0.1.0" />
        <Input label="Publisher ID" name="publisherId" required placeholder="publisher-slug-or-id" />
      </div>
      <div className="form-grid">
        <Input label="Categories" name="categories" placeholder="Sales, Reporting" />
        <Input label="Tags" name="tags" placeholder="CRM, Weekly reporting" />
      </div>
      <Input label="Package" name="packageFile" type="file" required accept=".zip,.agentkit.zip,application/zip" />
      <div className="rule-callout">
        <strong>Raw contents stay private</strong>
        <span>Validation may extract public-safe summaries, but this UI does not display package internals.</span>
      </div>
      <Button type="submit" disabled={state.status === "uploading"}>
        {state.status === "uploading" ? "Uploading..." : "Upload and validate"}
      </Button>
      <UploadStatus state={state} />
    </form>
  );
}

function UploadStatus({ state }: { state: UploadState }) {
  if (state.status === "idle") {
    return null;
  }

  if (state.status === "queued") {
    return (
      <div className="empty-state">
        <strong>Validation queued</strong>
        <p>{state.message}</p>
        <Link className="secondary-link" href={`/admin/submissions/${state.submissionId}`}>
          View submission
        </Link>
      </div>
    );
  }

  return (
    <div className={state.status === "failed" ? "empty-state danger-state" : "empty-state"}>
      <strong>{state.status === "failed" ? "Upload failed" : "Upload in progress"}</strong>
      <p>{state.message}</p>
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
    const message = isObject(json) && typeof json.message === "string" ? json.message : `Request failed with ${response.status}.`;
    throw new Error(message);
  }

  return isObject(json) ? json : {};
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
