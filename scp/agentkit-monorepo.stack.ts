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
 * =============================================================================================
 * REGENERATED AGAINST THE MIGRATED ESTATE — 2026-08-03
 * =============================================================================================
 * The earlier DO-NOT-APPLY banner is gone because what it warned about is fixed. That warning said
 * this manifest still declared the five env-suffixed prod components the ADR-0026 §6 migration
 * merges away, so applying it would have RECREATED them and re-established exactly the
 * component-per-environment duplication that migration removed.
 *
 * All five are now gone from this file, together with the two release topologies it declared
 * (`agentkit-gamma-then-prod`, `forge-gamma-then-prod`) — §6 step 5 RETIRED both, so declaring them
 * would have resurrected two soft-deleted objects.
 *
 * VERIFIED, not asserted: every URN this file declares was checked against the live graph —
 * 18 of 18 real declarations resolve to a LIVE object, none to a deleted one.
 *
 * WHERE THE SURVIVORS WENT. The five merged survivors (`agentkit-keycloak`, `agentkitmarket`,
 * `agentkitprofile`, `agentkit-auto`, `agentkit-forge-web`) are NOT declared here and should not be:
 * the `homelab-gitops` stack already declares them. This stack keeps the `agentkit` service, the six
 * `@agentkitforge/*` libraries, the six prod-only components with no gamma partner, and two
 * datastores. There is no component overlap between the two stacks — which matters, because moving an
 * object between stacks without landing both sides together lets the losing stack prune it.
 *
 * KNOWN GAPS — things the live graph has that this manifest cannot express:
 *   - `placement` objects. ADR-0026's pair type has NO construct in `@scp/iac` — the exports are
 *     Service/Component/Domain/Team/DeploymentTarget/Group/User/ServiceAccount/Campaign/Initiative/
 *     ReleaseTopology and nothing else. post-import-configuration.md §8 lists placements as "yes —
 *     a graph object, free", which is not true today: free on the WIRE (the manifest carries
 *     arbitrary `objects`), but there is no typed construct, so the 61 live placements are
 *     unmanaged by IaC and an apply cannot express them.
 *   - (RESOLVED) `source_mappings` — all 25 are now declared below. The earlier revision left them
 *     out and claimed an absent collection "prunes nothing". THAT WAS WRONG: `Stack.synth()` omits
 *     an empty collection, so ABSENT is the only way to say "none" and it prunes exactly like an
 *     empty one. Applying that revision would have deleted all 25. Verified after declaring them:
 *     the declared set equals the live set exactly, both directions — an apply creates nothing and
 *     prunes nothing.
 *   - `executor_bindings`. Carried by the manifest too, but unusable here: after the §6 migration 61
 *     of this estate's 66 bindings hang off a PLACEMENT, and a binding's `targetUrn` must name an
 *     object that exists. See docs/proposals/iac-placements.md.
 *   - the OLD note, kept for the part that is still true: `DesiredStateManifestSchema`
 *     (packages/schemas/src/iac.ts) now carries `sourceMappings`, `executorBindings` and (since C1)
 *     `placements`, so the wiring that was previously outside IaC IS reproduced here. Every one of
 *     those collections PRUNES when absent, so declaring them is not optional bookkeeping — see the
 *     comments at each block. The one thing still NOT expressible is an executor binding whose
 *     target is a PLACEMENT: those are refused as "on object(s) this stack does not manage", because
 *     ownership is inherited from the object a row hangs off and a placement cannot be declared in
 *     `objects[]` (#207 refuses pair-bound types at that door). The six Argo CD bindings on this
 *     stack's placements are therefore still managed outside IaC.
 *   - `hosted_on` has no fluent method on `ResourceConstruct` (only `dependsOn`/`consumes`/`owns`
 *     exist), so those edges are declared through `stack._registerRelationship` below. Same
 *     family of gap; worth a fluent method when C1 lands.
 */

import {
  App,
  Component,
  DeploymentTarget,
  ReleaseTopology,
  Service,
  Stack,
  Team,
  synthToFile,
} from "@scp/iac";
import { fileURLToPath } from "node:url";

export const STACK_NAME = "agentkit-monorepo";

export function buildStack(app: App = new App()): Stack {
  const stack = new Stack(app, STACK_NAME);

  const agentkit = new Service(stack, "agentkit", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:service:agentkit",
    name: "agentkit",
    properties: {},
  });

  // Deployment targets. `gamma` is the homelab k3s canary (its Applications live in the
  // homelab-gitops repo, whose stack references this object by URN); `prod` is DOKS.
  //
  // `environment` IS LOAD-BEARING, and omitting it fails silently (ADR-0026 D1). It is what makes a
  // place-role deployment-target derive a stage name at all — "Not every deployment-target is a
  // stage. Only those carrying `environment` derive a name". Plan compilation does NOT need it
  // (`resolveStagePlacements` only requires the wave target be type `deployment-target`), so a stack
  // that drops it keeps releasing perfectly while stage names quietly stop deriving.
  //
  // Both values were added to the LIVE objects by hand on 2026-08-02 (post-import-configuration.md
  // §6 step 1). They are declared here so an apply of this stack matches the live state instead of
  // reverting it — these objects are label-scoped to a stack and an apply overwrites what it
  // declares. `region` on prod was already present and is the optional middle segment of the
  // `<domain>-[<region>-]<environment>` grammar, giving `commercial-nyc3-prod`.
  const gamma = new DeploymentTarget(stack, "gamma", {
    urn: "urn:scp:agentkit-org:deployment-target:gamma",
    name: "gamma (self-host canary)",
    properties: {
      billing: "free",
      cluster: "homelab-k3s",
      environment: "gamma",
      gitops: "jag8765-personal/homelab-gitops",
      ingress: "tailf14b5e.ts.net",
      namespace: "agentkit",
    },
  });
  const prod = new DeploymentTarget(stack, "prod", {
    urn: "urn:scp:agentkit-org:deployment-target:prod",
    name: "prod (DOKS hosted)",
    properties: {
      billing: "managed",
      cluster: "do-nyc3-agentkitproject-prod",
      domain: "agentkitproject.com",
      environment: "prod",
      gitops: "AgentKitProject/agentkit-hosting",
      namespace: "agentkit",
      region: "nyc3",
    },
  });

  const maintainers = new Team(stack, "agentkit-maintainers", {
    urn: "urn:scp:agentkit-org:team:agentkit-maintainers",
    name: "AgentKit Maintainers",
    properties: {},
  });

  // The 17 agentkit components whose definitions live in this repo: the prod deployments
  // and the @agentkitforge/* workspace libraries.
  const agentkitDbBootstrapProd = new Component(
    stack,
    "agentkit-db-bootstrap-prod",
    {
      urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-db-bootstrap-prod",
      name: "agentkit-db-bootstrap-prod",
      service: agentkit,
      properties: {
        argocdApplication: "agentkit-db-bootstrap",
        argocdProject: "default",
        discoveredFrom: "argocd:http://argocd-prod.commanderscp",
        environment: "prod",
        namespace: "agentkit",
      },
    },
  );
  const agentkitHostedProd = new Component(stack, "agentkit-hosted-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-hosted-prod",
    name: "agentkit-hosted-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkit-hosted",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "argocd",
    },
  });
  const agentkitSealedSecretsProd = new Component(
    stack,
    "agentkit-sealed-secrets-prod",
    {
      urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-sealed-secrets-prod",
      name: "agentkit-sealed-secrets-prod",
      service: agentkit,
      properties: {
        argocdApplication: "agentkit-sealed-secrets",
        argocdProject: "default",
        discoveredFrom: "argocd:http://argocd-prod.commanderscp",
        environment: "prod",
        namespace: "kube-system",
      },
    },
  );
  const agentkitUmamiProd = new Component(stack, "agentkit-umami-prod", {
    urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-umami-prod",
    name: "agentkit-umami-prod",
    service: agentkit,
    properties: {
      argocdApplication: "agentkit-umami",
      argocdProject: "default",
      discoveredFrom: "argocd:http://argocd-prod.commanderscp",
      environment: "prod",
      namespace: "agentkit",
    },
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
      namespace: "agentkit",
    },
  });
  const agentkitprojectSiteProd = new Component(
    stack,
    "agentkitproject-site-prod",
    {
      urn: "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitproject-site-prod",
      name: "agentkitproject-site-prod",
      service: agentkit,
      properties: {
        argocdApplication: "agentkitproject-site",
        argocdProject: "default",
        discoveredFrom: "argocd:http://argocd-prod.commanderscp",
        environment: "prod",
        namespace: "agentkit",
      },
    },
  );
  const autoCore = new Component(stack, "auto-core", {
    urn: "urn:scp:agentkit-org:component:auto-core",
    name: "@agentkitforge/auto-core",
    service: agentkit,
    properties: {
      kind: "library",
      role: "Auto sandbox executor + budgets",
    },
  });
  const contracts = new Component(stack, "contracts", {
    urn: "urn:scp:agentkit-org:component:contracts",
    name: "@agentkitforge/contracts",
    service: agentkit,
    properties: {
      kind: "library",
      role: "cross-repo zod schemas + route builders",
    },
  });
  const core = new Component(stack, "core", {
    urn: "urn:scp:agentkit-org:component:core",
    name: "@agentkitforge/core",
    service: agentkit,
    properties: {
      kind: "library",
      role: "Agent Kit spec engine + market client + CLI",
    },
  });
  const gatewayCore = new Component(stack, "gateway-core", {
    urn: "urn:scp:agentkit-org:component:gateway-core",
    name: "@agentkitforge/gateway-core",
    service: agentkit,
    properties: {
      kind: "library",
      role: "inference gateway ports",
    },
  });
  const marketCore = new Component(stack, "market-core", {
    urn: "urn:scp:agentkit-org:component:market-core",
    name: "@agentkitforge/market-core",
    service: agentkit,
    properties: {
      kind: "library",
      role: "Market backend core",
    },
  });
  const ui = new Component(stack, "ui", {
    urn: "urn:scp:agentkit-org:component:ui",
    name: "@agentkitforge/ui",
    service: agentkit,
    properties: {
      kind: "library",
      role: "shared design system",
    },
  });

  // Shared infrastructure the service consumes. These two components carry no `contains`
  // edge in the live graph (they belong to no service), and `Component` would force one —
  // so they are referenced by URN and left owned by whatever created them.
  const managedPostgresProd =
    "urn:scp:agentkit-org:component:managed-postgres-prod";
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
  stack._registerRelationship({
    typeId: "hosted_on",
    from: agentkitDbBootstrapProd,
    to: prod,
  });
  stack._registerRelationship({
    typeId: "hosted_on",
    from: agentkitHostedProd,
    to: prod,
  });
  stack._registerRelationship({
    typeId: "hosted_on",
    from: agentkitSealedSecretsProd,
    to: prod,
  });
  stack._registerRelationship({
    typeId: "hosted_on",
    from: agentkitUmamiProd,
    to: prod,
  });
  stack._registerRelationship({
    typeId: "hosted_on",
    from: agentkitgatewayProd,
    to: prod,
  });
  stack._registerRelationship({
    typeId: "hosted_on",
    from: agentkitprojectSiteProd,
    to: prod,
  });

  // Release topologies. `properties.waves[].targets` hold RAW OBJECT IDS, exactly as the
  // live instance stores them. URNs would also resolve, but writing them here would rewrite
  // a live coordination object's properties for cosmetics — so the ids are kept verbatim and
  // this stays a pure adoption.

  // ---------------------------------------------------------------------------------------
  // SOURCE MAPPINGS — all 25 for the components this stack owns.
  //
  // ALL OR NOTHING, and that is not a style choice. The collection is authoritative for the
  // components this stack owns: whatever it does not list gets PRUNED. An ABSENT collection is
  // the same as an empty one — `Stack.synth()` omits an empty collection, so absent is the only
  // way to say "none" — which is why the previous revision, declaring no mappings at all, would
  // have deleted every one of these on apply.
  //
  // Declared via `stack.addSourceMapping(<urn>, ...)` rather than `component.mapsSource(...)`
  // deliberately: keying on the URN makes these independent of how the component declarations
  // above happen to be formatted, and the URNs are read from the live graph.
  // ---------------------------------------------------------------------------------------
  // PLACEMENTS (ADR-0026 / proposal §8 C1). NOT optional bookkeeping: a `placements` collection that
  // is ABSENT means "this stack declares none", which PRUNES every live placement of a component
  // this stack owns. All six of these carry an Argo CD executor binding, so an apply of a stack
  // that stayed silent would be REFUSED (409, decision Q2) rather than converge. Silence is a
  // statement here, and the only correct statement is the true one.
  //
  // These are the DERIVED `places`/`placed_at` edges, which is a different fact from the `hosted_on`
  // edges above — those stay, and are not produced by a placement.
  agentkitDbBootstrapProd.placeAt(prod);
  agentkitHostedProd.placeAt(prod);
  agentkitSealedSecretsProd.placeAt(prod);
  agentkitUmamiProd.placeAt(prod);
  agentkitgatewayProd.placeAt(prod);
  agentkitprojectSiteProd.placeAt(prod);

  // EXECUTOR BINDINGS on the two deployment-targets. Like `placements` above, an ABSENT collection
  // means "this stack declares none" and PRUNES — and these four are what actually drive the
  // github image/configuration pipelines, so a stack that stayed silent would delete them on apply.
  //
  // `config` carries the github App coordinates and the NAME of a secret key, never a secret value
  // (`privateKeySecretKey` / `secretRefs` are references; the material lives in SCP's encrypted
  // secret store). That is what makes these safe to commit.
  //
  // NOTE the two axes: each target is bound once per executor TYPE (ADR-0007) — `image` and
  // `configuration` are different pipelines pointing at different repos, not a duplicate.
  stack.addExecutorBinding(gamma, {
    type: "configuration",
    pluginModule: "github",
    pluginInstanceId: "github-homelab-gitops",
    config: {
      owner: "jag8765-personal",
      repo: "homelab-gitops",
      appId: "4324854",
      installationId: "147227885",
      privateKeySecretKey: "github-homelab-key",
    },
    secretRefs: { "github-homelab-key": "github-homelab-key" },
    allowedHosts: [],
  });
  stack.addExecutorBinding(gamma, {
    type: "image",
    pluginModule: "github",
    pluginInstanceId: "github-agentkit",
    config: {
      owner: "AgentKitProject",
      repo: "agentkit",
      appId: "4324822",
      installationId: "147227180",
      privateKeySecretKey: "github-agentkit-key",
    },
    secretRefs: { "github-agentkit-key": "github-agentkit-key" },
    allowedHosts: [],
  });
  stack.addExecutorBinding(prod, {
    type: "configuration",
    pluginModule: "github",
    pluginInstanceId: "github-agentkit-hosting",
    config: {
      owner: "AgentKitProject",
      repo: "agentkit-hosting",
      appId: "4324822",
      installationId: "147227180",
      privateKeySecretKey: "github-agentkit-key",
    },
    secretRefs: { "github-agentkit-key": "github-agentkit-key" },
    allowedHosts: [],
  });
  stack.addExecutorBinding(prod, {
    type: "image",
    pluginModule: "github",
    pluginInstanceId: "github-agentkit-commercial",
    config: {
      owner: "AgentKitProject",
      repo: "agentkit-commercial",
      appId: "4324822",
      installationId: "147227180",
      privateKeySecretKey: "github-agentkit-key",
    },
    secretRefs: { "github-agentkit-key": "github-agentkit-key" },
    allowedHosts: [],
  });

  stack.addSourceMapping("urn:scp:agentkit-org:component:auto-core", {
    sourceKind: "github",
    repoPattern: "AgentKitProject/agentkit",
    type: "configuration",
  });
  stack.addSourceMapping("urn:scp:agentkit-org:component:contracts", {
    sourceKind: "github",
    repoPattern: "AgentKitProject/agentkit",
    type: "configuration",
  });
  stack.addSourceMapping("urn:scp:agentkit-org:component:core", {
    sourceKind: "github",
    repoPattern: "AgentKitProject/agentkit",
    type: "configuration",
  });
  stack.addSourceMapping("urn:scp:agentkit-org:component:gateway-core", {
    sourceKind: "github",
    repoPattern: "AgentKitProject/agentkit",
    type: "configuration",
  });
  stack.addSourceMapping("urn:scp:agentkit-org:component:market-core", {
    sourceKind: "github",
    repoPattern: "AgentKitProject/agentkit",
    type: "configuration",
  });
  stack.addSourceMapping("urn:scp:agentkit-org:component:ui", {
    sourceKind: "github",
    repoPattern: "AgentKitProject/agentkit",
    type: "configuration",
  });
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-db-bootstrap-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-db-bootstrap-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit-hosting",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-db-bootstrap-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit-hosting",
      pathPattern: "deploy/db-bootstrap/**",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-hosted-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-hosted-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit-hosting",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-hosted-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit-hosting",
      pathPattern: "deploy/argocd/apps/**",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-sealed-secrets-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-sealed-secrets-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit-hosting",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-sealed-secrets-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit-hosting",
      pathPattern: "deploy/sealed-secrets/**",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-umami-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-umami-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit-hosting",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkit-umami-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit-hosting",
      pathPattern: "deploy/umami/**",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitgateway-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitgateway-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit",
      pathPattern: "deploy/charts/agentkitgateway/**",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitgateway-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit-commercial",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitgateway-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit-hosting",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitproject-site-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitproject-site-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit",
      pathPattern: "deploy/charts/agentkitproject-site/**",
      type: "configuration",
    },
  );
  stack.addSourceMapping(
    "urn:scp:019f577f-e911-73ef-be87-3cb48e1b767f:component:agentkitproject-site-prod",
    {
      sourceKind: "github",
      repoPattern: "AgentKitProject/agentkit-hosting",
      type: "configuration",
    },
  );

  return stack;
}

// `tsx <this file> [out.json]` writes the manifest `scp plan --manifest <out.json>` reads.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await synthToFile(
    buildStack(),
    process.argv[2] ?? "agentkit-monorepo.manifest.json",
  );
}
