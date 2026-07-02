/**
 * Fire-log plain-language labels (lib/automations/fire-log.ts) — the mapping
 * the Automations fire-log panel shows for every TriggerFireOutcome.
 */
import { describe, expect, it } from "vitest";
import { triggerFireOutcomeSchema } from "@agentkitforge/contracts";
import { FIRE_OUTCOME_LABELS, fireOutcomeLabel, fireOutcomeTone } from "@/lib/automations/fire-log";

describe("fireOutcomeLabel", () => {
  it("maps every contract outcome to its plain-language label", () => {
    expect(fireOutcomeLabel("run_created")).toBe("Run started");
    expect(fireOutcomeLabel("filtered")).toBe("Filtered out");
    expect(fireOutcomeLabel("suppressed_rate")).toBe("Rate limit");
    expect(fireOutcomeLabel("skipped_funds")).toBe("Insufficient funds");
    expect(fireOutcomeLabel("suppressed_circuit")).toBe("Paused (repeated failures)");
    expect(fireOutcomeLabel("error")).toBe("Error");
  });

  it("covers EVERY outcome in the contract enum (no silent drift)", () => {
    for (const outcome of triggerFireOutcomeSchema.options) {
      expect(FIRE_OUTCOME_LABELS[outcome]).toBeTruthy();
    }
    expect(Object.keys(FIRE_OUTCOME_LABELS).sort()).toEqual([...triggerFireOutcomeSchema.options].sort());
  });

  it("passes unknown outcomes through verbatim (forward compatibility)", () => {
    expect(fireOutcomeLabel("some_future_outcome")).toBe("some_future_outcome");
  });
});

describe("fireOutcomeTone", () => {
  it("run_created is success; intentional skips are neutral; failures are errors", () => {
    expect(fireOutcomeTone("run_created")).toBe("success");
    expect(fireOutcomeTone("filtered")).toBe("neutral");
    expect(fireOutcomeTone("suppressed_rate")).toBe("neutral");
    expect(fireOutcomeTone("skipped_funds")).toBe("error");
    expect(fireOutcomeTone("suppressed_circuit")).toBe("error");
    expect(fireOutcomeTone("error")).toBe("error");
    expect(fireOutcomeTone("mystery")).toBe("neutral");
  });
});
