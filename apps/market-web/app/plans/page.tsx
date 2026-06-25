import { PageShell } from "@/components/PageShell";

const AGENTKIT_PROJECT_ROADMAP_URL = "https://agentkitproject.com/roadmap";

export default function PlansPage() {
  return (
    <PageShell eyebrow="AgentKitProject" title="Roadmap">
      <div className="rule-callout">
        <strong>Centralized roadmap</strong>
        <span>Product roadmap content is maintained on the AgentKitProject site to avoid drift.</span>
        <a className="secondary-link" href={AGENTKIT_PROJECT_ROADMAP_URL}>
          View the AgentKitProject roadmap
        </a>
      </div>
    </PageShell>
  );
}
