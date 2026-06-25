"use client";

import { Button } from "@agentkitforge/ui";
import { buildForgeImportDeepLink, getForgeWebUrl } from "@/lib/forge-link";

export function OpenInForgeButton({ marketBaseUrl, slug }: { marketBaseUrl: string; slug: string }) {
  const deepLink = buildForgeImportDeepLink({ marketBaseUrl, slug });
  const forgeWebUrl = getForgeWebUrl();

  return (
    <div className="forge-import-actions">
      <Button
        className="full-width"
        type="button"
        onClick={() => {
          window.location.href = deepLink;
        }}
      >
        Open in Forge
      </Button>
      {forgeWebUrl ? (
        <a className="secondary-link" href={forgeWebUrl}>
          Forge not installed?
        </a>
      ) : null}
    </div>
  );
}
