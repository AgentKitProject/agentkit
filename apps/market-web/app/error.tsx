"use client";

import Link from "next/link";
import { Button } from "@agentkitforge/ui";

export default function AppError({ reset }: { reset: () => void }) {
  return (
    <section className="content-band">
      <div className="empty-state">
        <strong>Backend unavailable</strong>
        <p>The marketplace catalog could not load. Check the API configuration or try again in a moment.</p>
        <div className="hero-actions">
          <Button type="button" onClick={reset}>
            Try again
          </Button>
          <Link className="ghost-button" href="/">
            Home
          </Link>
        </div>
      </div>
    </section>
  );
}
