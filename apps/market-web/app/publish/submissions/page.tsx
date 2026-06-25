import Link from "next/link";
import { PageShell } from "@/components/PageShell";

const submissions = [
  { name: "Revenue Win-Loss Analyzer", status: "Draft", gate: "Needs metadata" },
  { name: "Customer Health Snapshot", status: "Validated", gate: "Awaiting review" }
];

export default function SubmissionsPage() {
  return (
    <PageShell eyebrow="Submission workspace" title="Submissions">
      <div className="table-panel">
        {submissions.map((submission) => (
          <div className="table-row" key={submission.name}>
            <strong>{submission.name}</strong>
            <span>{submission.status}</span>
            <span>{submission.gate}</span>
          </div>
        ))}
      </div>
      <Link className="primary-button" href="/submit">
        Submit kit
      </Link>
    </PageShell>
  );
}
