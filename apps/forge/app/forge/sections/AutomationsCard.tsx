"use client";

// "Automations" panel in the kit editor. Rendered only when the kit's
// agentkit.yaml declares suggested `automations:`. Each entry deep-links OUT
// to the AgentKitAuto wizard prefilled ("Enable in Auto") — Forge links out to
// Auto, it never embeds it (maintainer decision). The human reviews the prompt
// and completes schedule, approvals, budgets, destinations, and connections in
// the wizard; suggestions never carry them. When no Auto URL is configured
// (e.g. a self-host without Auto), entries render without the link.
import { Button } from "@agentkitforge/ui";
import { buildForgeAutomationsCardModel, type ForgeKitAutomation } from "./kit-automations";

export function AutomationsCard({
  automations,
  kitId,
  autoBaseUrl
}: {
  automations: ForgeKitAutomation[];
  kitId: string;
  autoBaseUrl?: string;
}) {
  const items = buildForgeAutomationsCardModel({ automations, kitId, autoBaseUrl });

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="results-panel" style={{ marginBottom: 12, padding: "12px 16px" }}>
      <p style={{ margin: "0 0 4px" }}>
        <strong>Automations</strong>
      </p>
      <p className="form-copy" style={{ marginTop: 0 }}>
        Suggested by the kit author. Nothing runs until you review the prompt and complete the
        schedule, approvals, and connections in AgentKitAuto.
      </p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {items.map((item) => (
          <li key={item.name} style={{ marginBottom: 8 }}>
            <strong>{item.name}</strong>
            {item.description ? ` — ${item.description}` : null}
            <br />
            <span className="form-copy">{item.triggerLabel}</span>
            <br />
            <span className="inline-code" style={{ fontSize: "0.82em" }}>{item.promptPreview}</span>
            {item.enableHref ? (
              <Button
                variant="secondary"
                size="sm"
                style={{ marginLeft: 10, textDecoration: "none" }}
                href={item.enableHref}
                target="_blank"
                rel="noreferrer"
              >
                Enable in Auto ↗
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
