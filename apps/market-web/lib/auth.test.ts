import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canDownloadKit,
  canPublishKit,
  canReviewSubmission,
  canSubmitKit,
  canViewKit,
  isAdminRole,
  type PermissionUser
} from "./permissions.ts";

const user: PermissionUser = {
  role: "user"
};

const admin: PermissionUser = {
  role: "admin"
};

describe("auth permissions", () => {
  it("keeps public kit viewing available to anonymous users", () => {
    assert.equal(canViewKit(), true);
  });

  it("allows signed-in users to download and submit kits", () => {
    assert.equal(canDownloadKit(user), true);
    assert.equal(canSubmitKit(user), true);
  });

  it("requires an admin or owner role for review and publish actions", () => {
    assert.equal(canReviewSubmission(user), false);
    assert.equal(canPublishKit(user), false);
    assert.equal(canReviewSubmission(admin), true);
    assert.equal(canPublishKit(admin), true);
    assert.equal(isAdminRole("owner"), true);
  });

  it("does not include a publisher role", () => {
    const roles = ["anonymous", "user", "admin", "owner"];

    assert.deepEqual(roles, ["anonymous", "user", "admin", "owner"]);
    assert.equal(roles.includes("publisher"), false);
  });
});
