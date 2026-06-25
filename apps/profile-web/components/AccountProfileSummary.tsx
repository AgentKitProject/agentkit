"use client";

import { Button } from "@agentkitforge/ui";
import { useEffect, useState } from "react";
import type { PrivateProfile } from "@/lib/profile/types";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; profile: PrivateProfile }
  | { status: "error"; message: string };

export function AccountProfileSummary() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;

    async function loadProfile() {
      try {
        const response = await fetch("/api/profile/me", {
          cache: "no-store",
          credentials: "include",
        });

        if (!response.ok) {
          throw new Error("Profile could not be loaded.");
        }

        const profile = (await response.json()) as PrivateProfile;

        if (active) {
          setState({ status: "loaded", profile });
        }
      } catch (error) {
        if (active) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Profile could not be loaded.",
          });
        }
      }
    }

    loadProfile();

    return () => {
      active = false;
    };
  }, []);

  if (state.status === "loading") {
    return <p className="text-sm text-[var(--muted)]">Loading profile...</p>;
  }

  if (state.status === "error") {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {state.message}
      </div>
    );
  }

  const { profile } = state;

  return (
    <div className="grid gap-5">
      {!profile.handle ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Set a public handle.
        </div>
      ) : null}
      <dl className="grid gap-4 sm:grid-cols-2">
        <SummaryItem label="Email" value={profile.email} note="Private" />
        <SummaryItem label="Role" value={profile.role} />
        <SummaryItem label="Display name" value={profile.displayName || "Not set"} />
        <SummaryItem label="Handle" value={profile.handle ? `@${profile.handle}` : "Not set"} />
      </dl>
      <div>
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="font-semibold text-slate-950">Profile completeness</span>
          <span className="font-semibold text-[var(--brand-strong)]">{profile.completeness}%</span>
        </div>
        <div className="mt-2 h-2 rounded-full bg-slate-100">
          <div className="h-2 rounded-full bg-[var(--brand)]" style={{ width: `${profile.completeness}%` }} />
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">
          {profile.isComplete ? "Your public profile has the required fields." : "Display name and handle are required for a complete profile."}
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button size="sm" href="/account/profile">
          Edit profile
        </Button>
        {profile.handle ? (
          <Button variant="secondary" size="sm" href={`/u/${profile.handle}`}>
            View public profile
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SummaryItem({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-base font-medium text-slate-950">{value}</dd>
      {note ? <p className="mt-1 text-xs font-medium text-[var(--brand)]">{note}</p> : null}
    </div>
  );
}
