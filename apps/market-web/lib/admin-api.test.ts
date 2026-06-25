import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAdminSubmissionDetail } from "./admin-api.ts";

describe("admin-api", () => {
  it("normalizes backend detail responses shaped as { item }", () => {
    const detail = normalizeAdminSubmissionDetail({
      item: {
        submissionId: "submission_test",
        kitId: "kit_test",
        publisherId: "publisher_agentkitproject",
        packageS3Key: "submissions/submission_test/package.agentkit.zip",
        status: "awaiting_upload",
        validationStatus: "pending",
        reviewStatus: "pending",
        listingDraft: {
          name: "Policy Review Assistant",
          summary: "Reviews policies for risky language.",
          description: "Draft description.",
          categories: ["Compliance"],
          tags: ["Policy", "Review"]
        },
        validationSummary: null,
        createdAt: "2026-06-02T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z"
      }
    });

    assert.equal(detail.submissionId, "submission_test");
    assert.equal(detail.kitId, "kit_test");
    assert.equal(detail.name, "Policy Review Assistant");
    assert.equal(detail.summary, "Reviews policies for risky language.");
    assert.equal(detail.description, "Draft description.");
    assert.equal(detail.status, "awaiting_upload");
    assert.equal(detail.validationStatus, "pending");
    assert.equal(detail.validationSummary, undefined);
    assert.equal(detail.packageS3Key, "submissions/submission_test/package.agentkit.zip");
    assert.deepEqual(detail.categories, ["Compliance"]);
    assert.deepEqual(detail.tags, ["Policy", "Review"]);
  });

  it("normalizes cleanup metadata and sanitizes validation failure summaries", () => {
    const detail = normalizeAdminSubmissionDetail({
      item: {
        submissionId: "submission_cleanup",
        name: "Cleanup test",
        validationStatus: "failed",
        reviewStatus: "pending",
        status: "archived",
        archivedAt: "2026-06-04T00:00:00.000Z",
        canceledAt: "2026-06-04T00:30:00.000Z",
        remove: {
          removedAt: "2026-06-04T02:00:00.000Z"
        },
        kit: {
          status: "hidden",
          hiddenAt: "2026-06-04T01:00:00.000Z"
        },
        validationSummary: {
          errors: ["Error at Validator.run (/var/task/index.js:10:20) while reading /tmp/package/raw.md"],
          warnings: ["Missing optional README summary."]
        }
      }
    });

    assert.equal(detail.archivedAt, "2026-06-04T00:00:00.000Z");
    assert.equal(detail.canceledAt, "2026-06-04T00:30:00.000Z");
    assert.equal(detail.removedAt, "2026-06-04T02:00:00.000Z");
    assert.equal(detail.kitStatus, "hidden");
    assert.equal(detail.hiddenAt, "2026-06-04T01:00:00.000Z");
    assert.match(detail.validationSummary?.errors?.[0] ?? "", /path hidden/);
    assert.doesNotMatch(detail.validationSummary?.errors?.[0] ?? "", /\/var\/task|\/tmp\/package/);
  });
});
