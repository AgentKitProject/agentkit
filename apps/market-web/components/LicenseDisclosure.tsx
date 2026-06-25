"use client";

import { useState } from "react";
import { Button } from "@agentkitforge/ui";

export function LicenseDisclosure({
  licenseText,
  licenseLabel
}: {
  licenseText: string;
  licenseLabel: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="detail-panel">
      <h2>License</h2>
      <p className="privacy-note">{licenseLabel}</p>
      <Button variant="secondary" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? "Hide license text" : "View license text"}
      </Button>
      {open ? <pre className="license-text">{licenseText}</pre> : null}
    </div>
  );
}
