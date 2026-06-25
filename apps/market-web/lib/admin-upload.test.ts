import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAdminCreateUploadUrlRequest,
  parseCommaSeparatedList,
  validateAdminCreateUploadUrlRequest
} from "./admin-upload.ts";

describe("admin-upload", () => {
  it("builds the backend upload payload with listingDraft", () => {
    assert.deepEqual(
      buildAdminCreateUploadUrlRequest({
        fileName: "example.agentkit.zip",
        version: "1.0.0",
        publisherId: "publisher_agentkitproject",
        name: "Sales Report Generator",
        summary: "Creates public-safe sales reports.",
        description: "A longer listing description.",
        categories: "Sales, Reporting",
        tags: "CRM, Weekly reporting"
      }),
      {
        fileName: "example.agentkit.zip",
        version: "1.0.0",
        publisherId: "publisher_agentkitproject",
        listingDraft: {
          name: "Sales Report Generator",
          summary: "Creates public-safe sales reports.",
          description: "A longer listing description.",
          categories: ["Sales", "Reporting"],
          tags: ["CRM", "Weekly reporting"]
        }
      }
    );
  });

  it("splits comma-separated categories and tags into trimmed arrays", () => {
    assert.deepEqual(parseCommaSeparatedList(" Sales, ,Reporting, CRM "), ["Sales", "Reporting", "CRM"]);
  });

  it("requires listingDraft in upload requests", () => {
    assert.equal(
      validateAdminCreateUploadUrlRequest({
        fileName: "example.agentkit.zip",
        version: "1.0.0",
        publisherId: "publisher_agentkitproject"
      }),
      "listingDraft is required."
    );
  });
});
