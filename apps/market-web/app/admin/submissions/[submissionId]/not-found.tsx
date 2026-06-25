import Link from "next/link";

export default function AdminSubmissionNotFound() {
  return (
    <section className="content-band">
      <div className="empty-state">
        <strong>Submission not found</strong>
        <p>This submission is not available in the admin queue.</p>
        <Link className="primary-button" href="/admin/submissions">
          Back to submissions
        </Link>
      </div>
    </section>
  );
}
