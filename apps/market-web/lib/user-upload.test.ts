import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { buildUserCreateUploadUrlRequest, validateUserCreateUploadUrlRequest } from "./user-upload.ts";

describe("user-upload", () => {
  it("builds listingDraft from comma-separated form values", () => {
    const payload = buildUserCreateUploadUrlRequest({
      fileName: "example.agentkit.zip",
      version: "1.0.0",
      name: "Support Ticket Classifier",
      summary: "Classifies support tickets.",
      description: "Public-safe description.",
      categories: "Support, Triage",
      tags: "Helpdesk, AI"
    });

    assert.deepEqual(payload, {
      fileName: "example.agentkit.zip",
      version: "1.0.0",
      listingDraft: {
        name: "Support Ticket Classifier",
        summary: "Classifies support tickets.",
        description: "Public-safe description.",
        categories: ["Support", "Triage"],
        tags: ["Helpdesk", "AI"]
      }
    });
    assert.equal(JSON.stringify(payload).includes("kitId"), false);
    assert.equal(JSON.stringify(payload).includes("slug"), false);
  });

  it("requires a package, kit name, summary, and version", () => {
    assert.equal(validateUserCreateUploadUrlRequest({}), "File is required.");
    assert.equal(
      validateUserCreateUploadUrlRequest({
        fileName: "example.agentkit.zip",
        version: "",
        listingDraft: {
          name: "Kit",
          summary: "Summary",
          categories: [],
          tags: []
        }
      }),
      "Version is required."
    );
  });

  it("does not reject duplicate listing names client-side", () => {
    const first = buildUserCreateUploadUrlRequest({
      fileName: "first.agentkit.zip",
      version: "1.0.0",
      name: "Same Kit Name",
      summary: "First package.",
      description: "",
      categories: "",
      tags: ""
    });
    const second = buildUserCreateUploadUrlRequest({
      fileName: "second.agentkit.zip",
      version: "1.0.1",
      name: "Same Kit Name",
      summary: "Second package.",
      description: "",
      categories: "",
      tags: ""
    });

    assert.equal(validateUserCreateUploadUrlRequest(first), null);
    assert.equal(validateUserCreateUploadUrlRequest(second), null);
    assert.equal(first.listingDraft.name, second.listingDraft.name);
  });

  it("does not expose user-editable kit id or slug fields in the web submit form", async () => {
    const formSource = await readFile(new URL("../components/UserSubmissionForm.tsx", import.meta.url), "utf8");

    assert.doesNotMatch(formSource, /name=["'](?:kitId|kitSlug|slug)["']/);
    assert.doesNotMatch(formSource, /placeholder=["'][^"']*(?:kit id|kit slug|slug)[^"']*["']/i);
    assert.match(formSource, /name="name"/);
    assert.match(formSource, /Market generates\s+the public kit URL/);
  });
});
