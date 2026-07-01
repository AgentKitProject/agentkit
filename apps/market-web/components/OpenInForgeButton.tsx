"use client";

import { Button } from "@agentkitforge/ui";
import { buildRunInForgeWebLink } from "@/lib/forge-link";

export function OpenInForgeButton({ slug }: { slug: string }) {
  // Web Forge (the desktop app is retired). Hidden when no Forge is configured
  // (e.g. self-host with no Forge deployment).
  const forgeUrl = buildRunInForgeWebLink({ slug });
  if (!forgeUrl) {
    return null;
  }

  return (
    <div className="forge-import-actions">
      <Button
        className="full-width"
        type="button"
        onClick={() => {
          window.location.href = forgeUrl;
        }}
      >
        Open in Forge
      </Button>
    </div>
  );
}
