import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  buildUserLifecycleRequest,
  buildUserUploadBackendRequest,
  filterOwnSubmissions,
  sanitizeUserSubmissionDetail
} from "./user-submissions.ts";

const user = {
  id: "user_123",
  email: "User@Example.com"
};

const publisherSnapshot = {
  displayName: "Research Builder",
  handle: "research-builder",
  avatarInitials: "RB",
  verified: true
};

describe("user submissions", () => {
  it("derives submitter identity from the signed-in session", () => {
    const untrustedRequest = {
      fileName: "example.agentkit.zip",
      version: "1.0.0",
      kitId: "kit_fake",
      slug: "fake-slug",
      kitSlug: "fake-kit-slug",
      submittedByUserId: "fake",
      submittedByEmail: "fake@example.com",
      listingDraft: {
        name: "Research Brief Builder",
        summary: "Builds a research brief.",
        description: "Public-safe description.",
        categories: [" Research ", ""],
        tags: ["AI", " Briefing "]
      }
    } as Parameters<typeof buildUserUploadBackendRequest>[0] & {
      kitId: string;
      slug: string;
      kitSlug: string;
    };

    const payload = buildUserUploadBackendRequest(
      untrustedRequest,
      user,
      publisherSnapshot
    );

    assert.equal(payload.submittedByUserId, "user_123");
    assert.equal(payload.submittedByEmail, "User@Example.com");
    assert.deepEqual(payload.publisherSnapshot, publisherSnapshot);
    assert.equal(payload.publisherId, "Research Builder");
    assert.deepEqual(payload.listingDraft.categories, ["Research"]);
    assert.deepEqual(payload.listingDraft.tags, ["AI", "Briefing"]);
    assert.equal(JSON.stringify(payload).includes("kit_fake"), false);
    assert.equal(JSON.stringify(payload).includes("fake-slug"), false);
    assert.equal(JSON.stringify(payload).includes("fake-kit-slug"), false);
  });

  it("filters submission lists to the current user", () => {
    const items = filterOwnSubmissions(
      [
        {
          submissionId: "own_by_user_id",
          name: "Own",
          submittedByUserId: "user_123",
          validationStatus: "pending",
          reviewStatus: "pending"
        },
        {
          submissionId: "own_by_email",
          name: "Own email",
          submittedByEmail: "user@example.com",
          validationStatus: "pending",
          reviewStatus: "pending"
        },
        {
          submissionId: "other",
          name: "Other",
          submittedByUserId: "other_user",
          validationStatus: "pending",
          reviewStatus: "pending"
        }
      ],
      user
    );

    assert.deepEqual(
      items.map((item) => item.submissionId),
      ["own_by_user_id", "own_by_email"]
    );
  });

  it("builds lifecycle requests from the session user only", () => {
    assert.deepEqual(buildUserLifecycleRequest(user), { userId: "user_123" });
  });

  it("removes admin-only fields from user-facing submission detail", () => {
    const detail = sanitizeUserSubmissionDetail({
      submissionId: "submission_test",
      name: "Test",
      validationStatus: "pending",
      reviewStatus: "pending",
      submittedByUserId: "user_123",
      submittedByEmail: "user@example.com",
      packageS3Key: "private/package.agentkit.zip",
      categories: [],
      tags: [],
      requiredInputs: [],
      preparedPrompts: [],
      skills: [],
      trustBadges: []
    });

    assert.equal(JSON.stringify(detail).includes("submittedByUserId"), false);
    assert.equal(JSON.stringify(detail).includes("submittedByEmail"), false);
    assert.equal(JSON.stringify(detail).includes("packageS3Key"), false);
  });

  it("requires AgentKitProfile display name before web submit calls the backend", async () => {
    const source = await readFile(new URL("../app/api/submissions/upload-url/route.ts", import.meta.url), "utf8");

    assert.match(source, /publisherSnapshot\.displayName/);
    assert.match(source, /AgentKitProfile display name is required for Market submission\./);
    assert.match(source, /status: 409/);
  });
});
