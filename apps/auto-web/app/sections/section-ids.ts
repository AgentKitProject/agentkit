// Auto dashboard sections — the sidebar nav tabs. Each maps to one full-width
// pane in AutoSection. Kept as a tiny shared module (mirrors forge-web's
// app/forge/section-ids.ts) so AutoApp (which renders the AppShell nav) and
// AutoSection (which renders the active pane) agree on the id set + titles.

export type AutoSectionId =
  | "run"
  | "runs"
  | "approvals"
  | "schedules"
  | "webhooks"
  | "settings";

export const AUTO_SECTIONS: { id: AutoSectionId; label: string; title: string }[] = [
  { id: "run", label: "Run", title: "Start a run" },
  { id: "runs", label: "History", title: "Run history" },
  { id: "approvals", label: "Approvals", title: "Standing approvals" },
  { id: "schedules", label: "Schedules", title: "Scheduled runs" },
  { id: "webhooks", label: "Triggers", title: "Triggers" },
  { id: "settings", label: "Settings", title: "Inference & billing" },
];

export const DEFAULT_AUTO_SECTION: AutoSectionId = "run";

export function isAutoSectionId(value: string): value is AutoSectionId {
  return AUTO_SECTIONS.some((s) => s.id === value);
}
