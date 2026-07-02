// Plain-language labels for trigger-fire outcomes (TriggerFireOutcome in
// @agentkitforge/contracts). The fire log is observability, not run history —
// suppressed/filtered fires never create run records, so these labels carry
// the "why didn't my automation run?" story.
import type { TriggerFireOutcome } from "@agentkitforge/contracts";

export const FIRE_OUTCOME_LABELS: Record<TriggerFireOutcome, string> = {
  run_created: "Run started",
  filtered: "Filtered out",
  suppressed_rate: "Rate limit",
  skipped_funds: "Insufficient funds",
  suppressed_circuit: "Paused (repeated failures)",
  error: "Error"
};

/** Label for an outcome; unknown values fall through verbatim (forward-compat). */
export function fireOutcomeLabel(outcome: string): string {
  return FIRE_OUTCOME_LABELS[outcome as TriggerFireOutcome] ?? outcome;
}

export type FireOutcomeTone = "success" | "neutral" | "error";

/** Badge tone: ran → success, intentionally skipped → neutral, broken → error. */
export function fireOutcomeTone(outcome: string): FireOutcomeTone {
  switch (outcome as TriggerFireOutcome) {
    case "run_created":
      return "success";
    case "filtered":
    case "suppressed_rate":
      return "neutral";
    case "skipped_funds":
    case "suppressed_circuit":
    case "error":
      return "error";
    default:
      return "neutral";
  }
}
