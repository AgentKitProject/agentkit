"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PageShell } from "@/components/PageShell";
import { KitOrgControls } from "@/components/KitOrgControls";
import type { Organization } from "@agentkitforge/contracts";
import Link from "next/link";
import { Button } from "@agentkitforge/ui";

export default function KitManagePage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const kitId = params.slug;
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [orgsLoaded, setOrgsLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/orgs", { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((payload: unknown) => {
        const items = Array.isArray(payload)
          ? (payload as Organization[])
          : Array.isArray((payload as Record<string, unknown>)?.items)
            ? ((payload as Record<string, unknown[]>).items as Organization[])
            : Array.isArray((payload as Record<string, unknown>)?.orgs)
              ? ((payload as Record<string, unknown[]>).orgs as Organization[])
              : [];
        setOrgs(items);
        setOrgsLoaded(true);
      })
      .catch(() => {
        setOrgsLoaded(true);
      });
  }, []);

  return (
    <PageShell
      eyebrow="Kit management"
      title={`Manage kit: ${kitId}`}
      actions={
        <Link className="secondary-link" href={`/kits/${encodeURIComponent(kitId)}`}>
          ← Kit details
        </Link>
      }
    >
      <div className="rule-callout">
        <strong>Organization controls</strong>
        <span>Transfer this kit to an organization or change its catalog visibility.</span>
      </div>
      {orgsLoaded ? (
        <KitOrgControls kitId={kitId} myOrgs={orgs} />
      ) : (
        <div className="empty-state">
          <strong>Loading…</strong>
        </div>
      )}
      <div style={{ marginTop: "2rem" }}>
        <Button variant="secondary" onClick={() => router.back()}>
          Back
        </Button>
      </div>
    </PageShell>
  );
}
