import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approveActionState,
  hideKitActionState,
  publishActionState,
  rejectActionState,
  removeListingActionState,
  removeSubmissionActionState,
  reviewSectionFor,
  unhideKitActionState
} from "./admin-actions.ts";
import type { AdminSubmissionListItem } from "./admin-api.ts";

const baseSubmission: AdminSubmissionListItem = {
  submissionId: "submission_test",
  name: "Test submission",
  validationStatus: "pending",
  reviewStatus: "pending"
};

describe("admin-actions", () => {
  it("disables approval until validation has passed", () => {
    assert.equal(approveActionState(baseSubmission).enabled, false);
    assert.equal(approveActionState({ ...baseSubmission, validationStatus: "passed" }).enabled, true);
  });

  it("disables publishing until validation has passed and review is approved", () => {
    assert.equal(publishActionState({ ...baseSubmission, validationStatus: "passed" }).enabled, false);
    assert.equal(publishActionState({ ...baseSubmission, validationStatus: "passed", reviewStatus: "approved" }).enabled, true);
  });

  it("requires review notes for rejection", () => {
    assert.equal(rejectActionState(baseSubmission, "").enabled, false);
    assert.equal(rejectActionState(baseSubmission, "Unsafe metadata.").enabled, true);
  });

  it("groups submissions into review sections", () => {
    assert.equal(reviewSectionFor(baseSubmission), "pending-validation");
    assert.equal(reviewSectionFor({ ...baseSubmission, validationStatus: "failed" }), "validation-failed");
    assert.equal(reviewSectionFor({ ...baseSubmission, validationStatus: "passed" }), "ready-for-review");
    assert.equal(reviewSectionFor({ ...baseSubmission, reviewStatus: "approved" }), "approved");
    assert.equal(reviewSectionFor({ ...baseSubmission, reviewStatus: "rejected" }), "rejected");
    assert.equal(reviewSectionFor({ ...baseSubmission, status: "published" }), "published");
    assert.equal(reviewSectionFor({ ...baseSubmission, status: "archived" }), "archived");
    assert.equal(reviewSectionFor({ ...baseSubmission, status: "canceled" }), "archived");
    assert.equal(reviewSectionFor({ ...baseSubmission, status: "removed" }), "archived");
    assert.equal(reviewSectionFor({ ...baseSubmission, archivedAt: "2026-06-04T00:00:00Z" }), "archived");
  });

  it("guards remove, hide, and unhide actions", () => {
    assert.equal(removeSubmissionActionState(baseSubmission).enabled, true);
    assert.equal(removeSubmissionActionState({ ...baseSubmission, status: "published" }).enabled, false);
    assert.equal(removeSubmissionActionState({ ...baseSubmission, status: "archived" }).enabled, false);

    assert.equal(hideKitActionState(baseSubmission).enabled, false);
    assert.equal(hideKitActionState({ ...baseSubmission, kitId: "kit_test", status: "published" }).enabled, true);
    assert.equal(hideKitActionState({ ...baseSubmission, kitId: "kit_test", status: "hidden" }).enabled, false);

    assert.equal(unhideKitActionState({ ...baseSubmission, kitId: "kit_test", status: "hidden" }).enabled, true);
    assert.equal(unhideKitActionState({ ...baseSubmission, kitId: "kit_test", status: "published" }).enabled, false);

    assert.equal(removeListingActionState(baseSubmission).enabled, false);
    assert.equal(removeListingActionState({ ...baseSubmission, kitId: "kit_test", status: "published" }).enabled, true);
    assert.equal(removeListingActionState({ ...baseSubmission, kitId: "kit_test", status: "removed" }).enabled, false);
  });
});
