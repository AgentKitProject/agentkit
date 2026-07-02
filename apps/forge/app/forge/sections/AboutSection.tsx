"use client";

import { useEffect, useState } from "react";
import type { Forge } from "./shared";
import { useConfig } from "../config-context";

export function AboutSection({ forge }: { forge: Forge }) {
  const { links } = useConfig();
  const [version, setVersion] = useState<string>("");
  useEffect(() => {
    void forge.getAppVersion().then(setVersion, () => setVersion("web"));
  }, [forge]);
  const hasLinks = links.projectUrl || links.marketUrl || links.forgeUrl;
  return (
    <div className="about-screen">
      <div className="about-panel">
        <h2>AgentKitForge</h2>
        <p className="form-copy">Build, validate, package, import, export, and submit Agent Kits from your browser. The same engine also powers the <span className="inline-code">agentkitforge</span> CLI, talking to the backend through the ForgeClient seam.</p>
        <div className="about-meta">
          <p className="form-copy">Version: <span className="inline-code">{version || "…"}</span></p>
        </div>
        {hasLinks && (
          <div className="about-links">
            {links.projectUrl && (
              <a href={links.projectUrl} target="_blank" rel="noreferrer">{links.projectUrl.replace(/^https?:\/\//, "")}</a>
            )}
            {links.marketUrl && (
              <a href={links.marketUrl} target="_blank" rel="noreferrer">Market</a>
            )}
            {links.forgeUrl && (
              <a href={links.forgeUrl} target="_blank" rel="noreferrer">Forge</a>
            )}
          </div>
        )}
      </div>
      <div className="about-panel">
        <h2>Desktop-only features</h2>
        <p className="form-copy">Some desktop capabilities are not available on the web by design: opening a local folder in your OS file manager, the native app updater, and picking local filesystem paths. On the web, packaging and exports download files, and imports use uploads.</p>
      </div>
    </div>
  );
}
