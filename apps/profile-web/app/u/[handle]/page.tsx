import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Card } from "@agentkitforge/ui";
import { getPublicProfileByHandle } from "@/lib/profile/service";
import { isValidHandle, normalizeHandle } from "@/lib/profile/validation";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  try {
    const { handle } = await params;
    const normalizedHandle = normalizeHandle(handle);
    if (!isValidHandle(normalizedHandle)) return { title: "Profile — AgentKitProject" };
    const profile = await getPublicProfileByHandle(normalizedHandle);
    if (!profile) return { title: "Profile — AgentKitProject" };
    const displayName = profile.displayName || `@${profile.handle}`;
    return {
      title: `${displayName} — AgentKitProject`,
      description: profile.bio ?? `${displayName}'s AgentKitProject profile.`,
      alternates: { canonical: `/u/${normalizedHandle}` },
      openGraph: {
        title: `${displayName} — AgentKitProject`,
        description: profile.bio ?? `${displayName}'s AgentKitProject profile.`,
        type: "profile",
        url: `https://profile.agentkitproject.com/u/${normalizedHandle}`,
        siteName: "AgentKitProject",
      },
      twitter: {
        card: "summary",
        title: `${displayName} — AgentKitProject`,
        description: profile.bio ?? `${displayName}'s AgentKitProject profile.`,
      },
    };
  } catch {
    return { title: "Profile — AgentKitProject" };
  }
}

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const normalizedHandle = normalizeHandle(handle);

  if (!isValidHandle(normalizedHandle)) {
    notFound();
  }

  const profile = await getPublicProfileByHandle(normalizedHandle);

  if (!profile) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-4xl px-5 py-12">
      <Card>
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--brand-soft)] text-2xl font-semibold text-[var(--brand-strong)]">
            {profile.avatarInitials || profile.displayName?.slice(0, 2).toUpperCase() || "AK"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-normal text-slate-950">
                {profile.displayName || `@${profile.handle}`}
              </h1>
              {profile.verified ? <Badge tone="brand">Verified</Badge> : null}
            </div>
            <p className="mt-2 text-sm font-semibold text-[var(--brand)]">@{profile.handle}</p>
            {profile.bio ? <p className="mt-5 max-w-2xl text-base leading-7 text-[var(--muted)]">{profile.bio}</p> : null}
            {profile.websiteUrl ? (
              <a className="mt-5 inline-flex text-sm font-semibold text-[var(--brand)] hover:text-[var(--brand-strong)]" href={profile.websiteUrl} rel="noreferrer" target="_blank">
                {profile.websiteUrl}
              </a>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
