import { Button, Card } from "@agentkitforge/ui";
import { getEcosystemLinks } from "@/lib/self-host";

type ConnectedApp = {
  name: string;
  description: string;
  url?: string;
};

/**
 * Server-resolved "Connected apps" grid: one card per ecosystem app that has a
 * link configured. On hosted all three resolve to the canonical
 * *.agentkitproject.com URLs; on self-host only the apps the operator configured
 * (NEXT_PUBLIC_*_URL) appear.
 */
export function ConnectedApps() {
  const links = getEcosystemLinks();

  const apps: ConnectedApp[] = [
    {
      name: "AgentKitForge",
      description: "Build, validate, package, and export Agent Kits — desktop app and web.",
      url: links.forgeUrl,
    },
    {
      name: "AgentKitMarket",
      description: "Discover, share, and install Agent Kits from the public catalog.",
      url: links.marketUrl,
    },
    {
      name: "AgentKitAuto",
      description: "Run Agent Kits as automated agents in the cloud.",
      url: links.autoUrl,
    },
  ];

  const connected = apps.filter((app): app is Required<ConnectedApp> => Boolean(app.url));

  if (connected.length === 0) {
    return <p className="text-sm text-[var(--muted)]">No connected apps are configured for this instance.</p>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {connected.map((app) => (
        <Card key={app.name}>
          <h2 className="text-lg font-semibold text-[var(--ak-text)]">{app.name}</h2>
          <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{app.description}</p>
          <Button className="mt-5" size="sm" href={app.url} target="_blank" rel="noreferrer">
            Open
          </Button>
        </Card>
      ))}
    </div>
  );
}
