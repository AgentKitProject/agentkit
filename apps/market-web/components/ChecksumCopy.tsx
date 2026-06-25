"use client";

import { useState } from "react";
import { Button } from "@agentkitforge/ui";

export function ChecksumCopy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copyChecksum() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="checksum-row">
      <code>{value}</code>
      <Button variant="secondary" size="sm" onClick={copyChecksum} type="button">
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
