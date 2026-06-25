import Link from "next/link";

export default function NotFound() {
  return (
    <section style={{ maxWidth: 640, margin: "80px auto", padding: "0 24px" }}>
      <p className="eyebrow">404 Not Found</p>
      <h1 style={{ fontSize: "2.4rem", marginTop: 8 }}>Page not found</h1>
      <p style={{ color: "var(--market-muted)", marginTop: 12 }}>
        The page you are looking for does not exist or has been moved.
      </p>
      <div style={{ marginTop: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Link className="primary-button" href="/">Home</Link>
        <Link className="ghost-button" href="/kits">Browse Kits</Link>
      </div>
    </section>
  );
}
