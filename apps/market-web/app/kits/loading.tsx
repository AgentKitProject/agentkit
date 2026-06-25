import { PageShell } from "@/components/PageShell";

export default function KitsLoading() {
  return (
    <PageShell eyebrow="Public catalog" title="Published Agent Kits">
      <div className="empty-state">
        <strong>Loading catalog</strong>
        <p>Fetching published, validated, and reviewed Agent Kits.</p>
      </div>
    </PageShell>
  );
}
