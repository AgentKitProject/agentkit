"use client";

import { useState } from "react";
import { Button } from "@agentkitforge/ui";
import type { KitDownloadResponse } from "@/lib/market-api";
import { readDownloadErrorMessage } from "@/lib/kit-download";

type DownloadState =
  | { status: "idle"; message?: undefined }
  | { status: "loading"; message?: undefined }
  | { status: "error"; message: string };

export function KitDownloadButton({ slug }: { slug: string }) {
  const [state, setState] = useState<DownloadState>({ status: "idle" });

  async function downloadKit() {
    setState({ status: "loading" });

    try {
      const response = await fetch(`/api/kits/${encodeURIComponent(slug)}/download`, {
        method: "POST",
        cache: "no-store",
        credentials: "include"
      });

      if (!response.ok) {
        setState({ status: "error", message: await readDownloadErrorMessage(response) });
        return;
      }

      const body = (await response.json()) as Partial<KitDownloadResponse>;

      if (!body.downloadUrl) {
        setState({ status: "error", message: "Download URL was not returned." });
        return;
      }

      window.location.href = body.downloadUrl;
      setState({ status: "idle" });
    } catch {
      setState({ status: "error", message: "Downloads are temporarily unavailable." });
    }
  }

  return (
    <div className="download-control">
      <Button
        className="full-width"
        disabled={state.status === "loading"}
        onClick={downloadKit}
        type="button"
      >
        {state.status === "loading" ? "Preparing download..." : "Download .agentkit.zip"}
      </Button>
      {state.status === "error" ? <p className="download-error">{state.message}</p> : null}
    </div>
  );
}
