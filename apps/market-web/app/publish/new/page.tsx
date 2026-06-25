import { PageShell } from "@/components/PageShell";
import { Button, Input, Textarea } from "@agentkitforge/ui";

export default function NewSubmissionPage() {
  return (
    <PageShell eyebrow="Submission draft" title="New kit submission">
      <form className="form-panel">
        <Input label="Kit name" placeholder="Example: Sales Report Generator" />
        <Textarea label="Summary" placeholder="Short public summary. Avoid raw prompt or skill content." />
        <Input label="Publisher" placeholder="Publisher profile name" />
        <Input label="Categories" placeholder="Sales, Reporting" />
        <div className="rule-callout">
          <strong>Upload disabled</strong>
          <span>Real package upload, storage, validation, and Forge import are intentionally out of scope for this shell.</span>
        </div>
        <Button type="button">
          Save placeholder
        </Button>
      </form>
    </PageShell>
  );
}
