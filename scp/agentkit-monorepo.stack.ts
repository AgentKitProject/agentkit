/**
 * CommanderSCP desired-state stack — the agentkit service, its prod deployments and workspace libraries
 *
 * Generated from the LIVE homelab CommanderSCP instance's graph on 2026-08-02 and committed here,
 * beside the ArgoCD Application manifests that define these components, so the graph's shape is
 * reviewed in the same PR as the thing it describes. Owner decision, 2026-08-02.
 *
 * Stack name: "agentkit-monorepo"
 * ---------------------------------------------------------------------------------------------
 * PRUNING IS STACK-SCOPED. `scp apply` deletes only objects/relationships carrying BOTH
 * `scp:managed-by=iac` AND `scp:stack=agentkit-monorepo` (apps/server/src/iac/plans-repo.ts,
 * `fetchManagedObjects`). Never reuse this stack name for another manifest, and never move an
 * object between the two stacks without landing both sides in the same change — the losing stack
 * would prune it.
 *
 * EVERY OBJECT CARRIES AN EXPLICIT `urn`. `deriveConstructUrn` (packages/iac/src/urn.ts) would
 * mint `urn:scp:<stackName>:<type>:<id>`, which does NOT match what the live instance already
 * holds. The explicit URNs below were read out of `objects.urn` verbatim, so `scp plan` ADOPTS
 * the existing objects instead of creating duplicates.
 *
 * KNOWN GAPS — things the live graph has that this manifest cannot express:
 *   - `source_mappings` and `executor_bindings`. `DesiredStateManifestSchema`
 *     (packages/schemas/src/iac.ts) carries only `objects` and `relationships`, so the ArgoCD
 *     bindings and change-source mappings that actually wire these components to their executors
 *     live outside IaC and are NOT reproduced here. Tracked as proposal §8 item C1.
 *   - `hosted_on` has no fluent method on `ResourceConstruct` (only `dependsOn`/`consumes`/`owns`
 *     exist), so those edges are declared through `stack._registerRelationship` below. Same
 *     family of gap; worth a fluent method when C1 lands.
 */

import { App, Component, DeploymentTarget, ReleaseTopology, Service, Stack, Team, synthToFile } from "@scp/iac";
import { fileURLToPath } from "node:url";

export const STACK_NAME = "agentkit-monorepo";

export function buildStack(app: App = new App()): Stack {
  const stack = new Stack(app, STACK_NAME);

  const agentkit = new Service(stack, "agentkit", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:service:agentkit",
    name: "agentkit",
    properties: {}
  });

  // Deployment targets. `gamma` is the homelab k3s canary (its Applications live in the
  // homelab-gitops repo, whose stack references this object by URN); `prod` is DOKS.
  const gamma = new DeploymentTarget(stack, "gamma", {
    urn: "urn:scp:agentkit-org:deployment-target:gamma",
    name: "gamma (self-host canary)",
    properties: {
      billing: "free",
      cluster: "homelab-k3s",
      gitops: "jag8765-personal/homelab-gitops",
      ingress: "tailf14b5e.ts.net",
      namespace: "agentkit"
    }
  });
  const prod = new DeploymentTarget(stack, "prod", {
    urn: "urn:scp:agentkit-org:deployment-target:prod",
    name: "prod (DOKS hosted)",
    properties: {
      billing: "managed",
      cluster: "do-nyc3-agentkitproject-prod",
      domain: "agentkitproject.com",
      gitops: "AgentKitProject/agentkit-hosting",
      namespace: "agentkit",
      region: "nyc3"
    }
  });

  const maintainers = new Team(stack, "agentkit-maintainers", {
    urn: "urn:scp:agentkit-org:team:agentkit-maintainers",
    name: "AgentKit Maintainers",
    properties: {}
  });

  // The 17 agentkit components whose definitions live in this repo: the prod deployments
  // and the @agentkitforge/* workspace libraries.
  const agentkitDbBootstrapProd = new Component(stack, "agentkit-db-bootstrap-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-db-bootstrap-prod",
    name: "agentkit-db-bootstrap-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkit-db-bootstrap",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "agentkit"
    }
  });
  const agentkitHostedProd = new Component(stack, "agentkit-hosted-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-hosted-prod",
    name: "agentkit-hosted-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkit-hosted",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "argocd"
    }
  });
  const agentkitKeycloakProd = new Component(stack, "agentkit-keycloak-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-keycloak-prod",
    name: "agentkit-keycloak-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkit-keycloak",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "agentkit"
    }
  });
  const agentkitSealedSecretsProd = new Component(stack, "agentkit-sealed-secrets-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-sealed-secrets-prod",
    name: "agentkit-sealed-secrets-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkit-sealed-secrets",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "kube-system"
    }
  });
  const agentkitUmamiProd = new Component(stack, "agentkit-umami-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-umami-prod",
    name: "agentkit-umami-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkit-umami",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "agentkit"
    }
  });
  const agentkitautoProd = new Component(stack, "agentkitauto-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitauto-prod",
    name: "agentkitauto-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkitauto",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "agentkit"
    }
  });
  const agentkitforgeWebProd = new Component(stack, "agentkitforge-web-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitforge-web-prod",
    name: "agentkitforge-web-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkitforge-web",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "agentkit"
    }
  });
  const agentkitgatewayProd = new Component(stack, "agentkitgateway-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitgateway-prod",
    name: "agentkitgateway-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkitgateway",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "agentkit"
    }
  });
  const agentkitmarketProd = new Component(stack, "agentkitmarket-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitmarket-prod",
    name: "agentkitmarket-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkitmarket",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "agentkit"
    }
  });
  const agentkitprofileProd = new Component(stack, "agentkitprofile-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitprofile-prod",
    name: "agentkitprofile-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkitprofile",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "agentkit"
    }
  });
  const agentkitprojectSiteProd = new Component(stack, "agentkitproject-site-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitproject-site-prod",
    name: "agentkitproject-site-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkitproject-site",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "agentkit"
    }
  });
  const autoCore = new Component(stack, "auto-core", {
    urn: "urn:scp:agentkit-org:component:auto-core",
    name: "@agentkitforge/auto-core",
    service: agentkit,
    properties: {
      kind: "library",
      role: "Auto sandbox executor + budgets"
    }
  });
  const contracts = new Component(stack, "contracts", {
    urn: "urn:scp:agentkit-org:component:contracts",
    name: "@agentkitforge/contracts",
    service: agentkit,
    properties: {
      kind: "library",
      role: "cross-repo zod schemas + route builders"
    }
  });
  const core = new Component(stack, "core", {
    urn: "urn:scp:agentkit-org:component:core",
    name: "@agentkitforge/core",
    service: agentkit,
    properties: {
      kind: "library",
      role: "Agent Kit spec engine + market client + CLI"
    }
  });
  const gatewayCore = new Component(stack, "gateway-core", {
    urn: "urn:scp:agentkit-org:component:gateway-core",
    name: "@agentkitforge/gateway-core",
    service: agentkit,
    properties: {
      kind: "library",
      role: "inference gateway ports"
    }
  });
  const marketCore = new Component(stack, "market-core", {
    urn: "urn:scp:agentkit-org:component:market-core",
    name: "@agentkitforge/market-core",
    service: agentkit,
    properties: {
      kind: "library",
      role: "Market backend core"
    }
  });
  const ui = new Component(stack, "ui", {
    urn: "urn:scp:agentkit-org:component:ui",
    name: "@agentkitforge/ui",
    service: agentkit,
    properties: {
      kind: "library",
      role: "shared design system"
    }
  });

  // Shared infrastructure the service consumes. These two components carry no `contains`
  // edge in the live graph (they belong to no service), and `Component` would force one —
  // so they are referenced by URN and left owned by whatever created them.
  const managedPostgresProd = "urn:scp:agentkit-org:component:managed-postgres-prod";
  const objectStorage = "urn:scp:agentkit-org:component:object-storage";

  agentkit.consumes(managedPostgresProd);
  agentkit.consumes(objectStorage);

  // Ownership.
  maintainers.owns(agentkit);
  maintainers.owns(autoCore);
  maintainers.owns(contracts);
  maintainers.owns(core);
  maintainers.owns(gatewayCore);
  maintainers.owns(managedPostgresProd);
  maintainers.owns(marketCore);
  maintainers.owns(objectStorage);
  maintainers.owns(ui);

  // `hosted_on` — see KNOWN GAPS above for why this is not a fluent method.
  stack._registerRelationship({ typeId: "hosted_on", from: agentkitDbBootstrapProd, to: prod });
  stack._registerRelationship({ typeId: "hosted_on", from: agentkitHostedProd, to: prod });
  stack._registerRelationship({ typeId: "hosted_on", from: agentkitKeycloakProd, to: prod });
  stack._registerRelationship({ typeId: "hosted_on", from: agentkitSealedSecretsProd, to: prod });
  stack._registerRelationship({ typeId: "hosted_on", from: agentkitUmamiProd, to: prod });
  stack._registerRelationship({ typeId: "hosted_on", from: agentkitautoProd, to: prod });
  stack._registerRelationship({ typeId: "hosted_on", from: agentkitforgeWebProd, to: prod });
  stack._registerRelationship({ typeId: "hosted_on", from: agentkitgatewayProd, to: prod });
  stack._registerRelationship({ typeId: "hosted_on", from: agentkitmarketProd, to: prod });
  stack._registerRelationship({ typeId: "hosted_on", from: agentkitprofileProd, to: prod });
  stack._registerRelationship({ typeId: "hosted_on", from: agentkitprojectSiteProd, to: prod });

  // Release topologies. `properties.waves[].targets` hold RAW OBJECT IDS, exactly as the
  // live instance stores them. URNs would also resolve, but writing them here would rewrite
  // a live coordination object's properties for cosmetics — so the ids are kept verbatim and
  // this stays a pure adoption.
  new ReleaseTopology(stack, "agentkit-gamma-then-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:release-topology:agentkit-gamma-then-prod",
    name: "agentkit-gamma-then-prod",
    waves: [
      {
        mode: "parallel",
        name: "gamma",
        targets: [
          "019f662a-93dd-77e9-8dc3-f7790a614219",
          "019f662a-93e6-776a-9756-ae1fa55f6d3b",
          "019f662a-93ed-718b-8572-8fecec8994dc",
          "019f662a-93f4-75b9-a60a-1f39f070ab4a",
          "019f662a-9401-727b-be73-c92d1153f2fe",
          "019f662a-9406-777d-9f3d-1f1db2598394",
          "019f662a-93fa-75f8-b297-772560c25fd4"
        ]
      },
      {
        mode: "parallel",
        name: "prod",
        targets: [
          "019f6fb7-5a95-769d-b13b-7af760f0865a",
          "019f6fb7-5a7b-70c9-bcb2-88cdfdd7f3e4",
          "019f6fb7-5a99-76dc-a22b-f055db686ba9",
          "019f6fb7-5a9e-71dc-8cc1-3e71114e1d1f",
          "019f6fb7-5a83-76fa-afb4-002af5cd2430",
          "019f6fb7-5a88-7034-beaf-8b7585aebf87",
          "019f6fb7-5aa4-72e3-9fc3-266dea0d9325",
          "019f6fb7-5aa9-7439-bdc0-36a732e48366",
          "019f6fb7-5aad-71d8-a619-ec1b5bf4edae",
          "019f6fb7-5a8c-772c-8e99-23e9f48fd40b",
          "019f6fb7-5a91-77af-989f-4eeaf31d7502"
        ]
      }
    ]
  });
  new ReleaseTopology(stack, "forge-gamma-then-prod", {
    urn: "urn:scp:agentkit-org:release-topology:forge-gamma-then-prod",
    name: "forge-gamma-then-prod",
    waves: [
      {
        mode: "sequential",
        name: "gamma",
        targets: [
          "019f5790-9b75-7488-824f-d9efed328ba8"
        ]
      },
      {
        mode: "sequential",
        name: "prod",
        targets: [
          "019f5790-9b7c-70a2-b06c-fc26a3e6bd02"
        ]
      }
    ]
  });

  return stack;
}

// `tsx <this file> [out.json]` writes the manifest `scp plan --manifest <out.json>` reads.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await synthToFile(buildStack(), process.argv[2] ?? "agentkit-monorepo.manifest.json");
}
