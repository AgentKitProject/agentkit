"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Field, Input, Select } from "@agentkitforge/ui";
import type { CatalogEntry, Forge, Notify, PublicProvider } from "./shared";
import { errMsg } from "./shared";
import { CreditsPanel } from "./CreditsPanel";
import { useConfig } from "../config-context";

export function SettingsSection({ forge, notify }: { forge: Forge; notify: Notify }) {
  const { creditsEnabled, allowedProviders } = useConfig();
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [defaultId, setDefaultId] = useState<string | undefined>(undefined);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [busy, setBusy] = useState(false);

  // Provider-lock: when the operator restricts ALLOWED_PROVIDERS, hide disallowed
  // provider types from the add/update form (the server enforces it regardless).
  const isAllowed = useCallback(
    (type: string) => allowedProviders === null || allowedProviders.includes(type as never),
    [allowedProviders]
  );
  const visibleCatalog = catalog.filter((c) => isAllowed(c.providerType));

  const [providerType, setProviderType] = useState("openai");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [apiKey, setApiKey] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/ai-providers", { credentials: "include" }).then((r) => r.json());
    setProviders((res as { providers?: PublicProvider[] }).providers ?? []);
    setDefaultId((res as { defaultProviderId?: string }).defaultProviderId);
    setCatalog((res as { catalog?: CatalogEntry[] }).catalog ?? []);
  }, []);

  useEffect(() => {
    void load().catch((e) => notify(errMsg(e), true));
  }, [load, notify]);

  // Keep the selected provider type within the allowed set (e.g. after the
  // catalog loads, or if the default "openai" is locked out by the operator).
  useEffect(() => {
    if (visibleCatalog.length > 0 && !visibleCatalog.some((c) => c.providerType === providerType)) {
      setProviderType(visibleCatalog[0].providerType);
    }
  }, [visibleCatalog, providerType]);

  const cat = visibleCatalog.find((c) => c.providerType === providerType);

  const add = async () => {
    setBusy(true);
    try {
      await forge.saveAiProvider({
        name: name.trim() || providerType,
        providerType,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        defaultModel: defaultModel.trim() || cat?.defaultModel || "",
        supportsStructuredJson: cat?.supportsStructuredJson ?? false
      } as never);
      notify("Provider saved.");
      setApiKey("");
      setName("");
      await load();
    } catch (e) {
      notify(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const guard = (fn: () => Promise<unknown>, ok: string) => async () => {
    try {
      await fn();
      notify(ok);
      await load();
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  const test = async (id: string) => {
    try {
      const res = await forge.testAiProviderConnection({ providerId: id, model: "" });
      notify(res.ok ? `OK: ${res.message}` : `Failed: ${res.message}`, !res.ok);
    } catch (e) {
      notify(errMsg(e), true);
    }
  };

  return (
    <div className="settings-screen">
      <div className="settings-panel">
        {creditsEnabled && (
          <>
            <h2>Credits</h2>
            <p className="form-copy">Prepaid credits power managed AI when you have no provider configured below.</p>
            <CreditsPanel notify={notify} showDevGrant />
          </>
        )}
        <h2>AI providers</h2>
        <p className="form-copy">Configure per-user AI providers (used by Build with AI). API keys are stored server-side and never sent back to the browser.</p>
        {providers.length === 0 ? (
          <p className="form-copy">No providers configured yet.</p>
        ) : (
          <div className="provider-list">
            {providers.map((p) => (
              <article className="provider-card" key={p.id}>
                <h3>{p.name} {p.id === defaultId && <Badge tone="success">default</Badge>}</h3>
                <p>{p.providerType} · {p.defaultModel || "no model"} · <span className={`secret-status ${p.hasApiKey ? "saved" : ""}`}>{p.hasApiKey ? "key set" : "no key"}</span></p>
                <div className="button-row">
                  {p.id !== defaultId && <Button variant="secondary" onClick={guard(() => forge.setDefaultAiProvider(p.id), "Default provider set.")}>Make default</Button>}
                  <Button variant="secondary" onClick={() => void test(p.id)}>Test</Button>
                  <Button variant="danger" onClick={guard(() => forge.removeAiProvider(p.id), "Provider removed.")}>Remove</Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="settings-panel">
        <h2>Add / update a provider</h2>
        <Field label="Provider type">
          <Select value={providerType} onChange={(e) => setProviderType(e.target.value)}>
            {visibleCatalog.length === 0 && isAllowed("openai") && <option value="openai">openai</option>}
            {visibleCatalog.map((c) => (
              <option key={c.providerType} value={c.providerType}>{c.providerType}</option>
            ))}
          </Select>
        </Field>
        <Field label="Display name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={providerType} />
        </Field>
        <Field label="Default model">
          {cat && cat.models.length > 0 ? (
            <Select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}>
              <option value="">{cat.defaultModel ? `default (${cat.defaultModel})` : "select…"}</option>
              {cat.models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </Select>
          ) : (
            <Input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} />
          )}
        </Field>
        {cat?.baseUrlRequired && (
          <Field label="Base URL">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" />
          </Field>
        )}
        {(cat?.apiKeyRequired ?? true) && (
          <Field label="API key (stored server-side, not echoed back)">
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </Field>
        )}
        <Button disabled={busy} loading={busy} onClick={() => void add()}>{busy ? "Saving…" : "Save provider"}</Button>
      </div>
    </div>
  );
}
