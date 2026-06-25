import Link from "next/link";
import { PageShell } from "@/components/PageShell";

export default function PublishPage() {
  return (
    <PageShell eyebrow="Submission workspace" title="Publish reusable Agent Kits">
      <div className="two-column">
        <div className="flow-card">
          <span className="step-number">01</span>
          <h2>Prepare metadata</h2>
          <p>Name, summary, publisher profile, categories, version, required inputs, prompt summaries, and skill summaries.</p>
        </div>
        <div className="flow-card">
          <span className="step-number">02</span>
          <h2>Submit for validation</h2>
          <p>Any signed-in AgentKitProject user can submit kits for validation.</p>
        </div>
        <div className="flow-card">
          <span className="step-number">03</span>
          <h2>Review and moderation</h2>
          <p>Validated kits wait for human review before appearing publicly in AgentKitMarket.</p>
        </div>
        <div className="flow-card action-card">
          <h2>Start a submission</h2>
          <p>Upload a `.agentkit.zip` package through the signed-in submission flow.</p>
          <Link className="primary-button" href="/submit">
            Submit kit
          </Link>
        </div>
      </div>
    </PageShell>
  );
}
