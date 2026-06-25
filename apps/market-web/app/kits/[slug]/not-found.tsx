import Link from "next/link";

export default function KitNotFound() {
  return (
    <section className="content-band">
      <div className="empty-state">
        <strong>Kit not found</strong>
        <p>This kit is not available in the public catalog. It may still be awaiting validation or review.</p>
        <Link className="primary-button" href="/kits">
          Back to catalog
        </Link>
      </div>
    </section>
  );
}
