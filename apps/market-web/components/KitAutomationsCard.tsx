import { buildKitAutomationsCardModel } from "@/lib/kit-automations";
import type { KitAutomationSummary } from "@/lib/kit-automations";

/**
 * "Automations" panel on the kit detail page. Rendered only when the kit
 * declares suggested automations. Each entry deep-links into the AgentKitAuto
 * wizard prefilled ("Enable in Auto"); the human reviews the prompt and
 * completes approvals, budgets, destinations, and connections in the wizard —
 * suggestions never carry them. When no Auto app URL is configured (e.g. a
 * self-host without Auto), the suggestions render without the button.
 */
export function KitAutomationsCard({
  automations,
  slug,
  kitId,
  autoBaseUrl
}: {
  automations?: KitAutomationSummary[];
  slug: string;
  kitId?: string;
  autoBaseUrl?: string;
}) {
  const items = buildKitAutomationsCardModel({
    automations: automations ?? [],
    slug,
    kitId,
    autoBaseUrl
  });

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="detail-panel">
      <h2>Automations</h2>
      <p className="privacy-note">
        Suggested by the kit author. Nothing runs until you review the prompt and complete the
        schedule, approvals, and connections in AgentKitAuto.
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.name}>
            <strong>{item.name}</strong>
            {item.description ? `: ${item.description}` : null}
            <br />
            <span>{item.triggerLabel}</span>
            {item.enableHref ? (
              <>
                {" — "}
                <a className="secondary-link" href={item.enableHref}>
                  Enable in Auto
                </a>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
