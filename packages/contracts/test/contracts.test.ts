import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  forgeMarketRoutes,
  forgeOrgRoutes,
  forgeUploadBackendRequestSchema,
  marketBackendOrgRoutes,
  marketBackendPricingRoutes,
  forgePricingRoutes,
  marketServiceRoutes,
  marketServiceAuthHeader,
  serviceLicensedPackageRequestSchema,
  serviceLicensedPackageResponseSchema,
  serviceLicensedPackageErrorSchema,
  serviceEntitledKitsRequestSchema,
  serviceEntitledKitsResponseSchema,
  serviceEntitledKitsErrorSchema,
  entitlementSchema,
  setKitPricingRequestSchema,
  grantEntitlementRequestSchema,
  kitPricingMetadataSchema,
  DEFAULT_KIT_LICENSE_VERSION,
  organizationSchema,
  orgMembershipSchema,
  orgPayoutRoutes,
  setOrgStripeAccountRequestSchema,
  favoriteSchema,
  addFavoriteRequestSchema,
  listFavoritesResponseSchema,
  marketBackendFavoritesRoutes,
  forgeFavoritesRoutes,
  browserFavoritesRoutes,
  auditEventSchema,
  listAuditLogsQuerySchema,
  listAuditLogsResponseSchema,
  auditActionSchema,
  marketBackendAuditRoutes,
  browserAuditRoutes,
  profileRoutes,
  publicKitDetailResponseSchema,
  publicPublisherProfileSchema,
  serviceManifestSchema,
  autoRunSchema,
  autoApprovalSchema,
  autoScheduleSchema,
  publicAutoWebhookSchema,
  autoWebhookSchema,
  createAutoWebhookResponseSchema,
  createAutoRunRequestSchema,
  createAutoApprovalRequestSchema,
  networkPolicySchema,
  autoRunStatusSchema,
  runTriggerSchema,
  autoErrorCodeSchema,
  autoRoutes,
  forgeAutoRoutes,
  autoHookRoutes,
  autoInternalRoutes,
  autoWebhookSecretHeader,
  autoInternalServiceKeyHeader
} from "../dist/index.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

describe("contracts", () => {
  it("fixtures satisfy their schemas", () => {
    publicPublisherProfileSchema.parse(fixture("public-publisher-profile.json"));
    forgeUploadBackendRequestSchema.parse(fixture("forge-upload-backend-request.json"));
    publicKitDetailResponseSchema.parse(fixture("public-kit-detail.json"));
  });

  it("route builders match the canonical route table", () => {
    const routes = fixture("routes.json");
    assert.equal(profileRoutes.publicByUserId("{userId}"), routes.profileApi.publicByUserId.replace("{userId}", "%7BuserId%7D"));
    assert.equal(profileRoutes.publicByUserId("u1"), "/profiles/u1");
    assert.equal(profileRoutes.publicByHandle("h1"), "/profiles/handle/h1");
    assert.equal(forgeMarketRoutes.download("my-kit"), "/api/forge/kits/my-kit/download");
    assert.equal(forgeMarketRoutes.kitDetail("my-kit"), "/api/forge/kits/my-kit");
    assert.equal(forgeMarketRoutes.kitDetail("my-kit"), routes.forgeMarket.kitDetail.replace("{slug}", "my-kit"));
    assert.equal(forgeMarketRoutes.submissionUploadUrl(), routes.forgeMarket.submissionUploadUrl);
    assert.equal(forgeMarketRoutes.submissionValidate("s1"), "/api/forge/submissions/s1/validate");
    assert.equal(forgeMarketRoutes.publisherProfile(), routes.forgeMarket.publisherProfile);
  });

  it("profile public route has no /public suffix (regression: Bridge 4 blocker)", () => {
    assert.ok(!profileRoutes.publicByUserId("u1").endsWith("/public"));
  });

  it("org fixtures satisfy their schemas", () => {
    organizationSchema.parse(fixture("organization.json"));
    orgMembershipSchema.parse(fixture("org-membership.json"));
  });

  it("forgeOrgRoutes produce expected paths", () => {
    const routes = fixture("routes.json");
    assert.equal(forgeOrgRoutes.listMyOrgs(), routes.forgeOrgs.listMyOrgs);
    assert.equal(forgeOrgRoutes.createOrg(), routes.forgeOrgs.createOrg);
    assert.equal(
      forgeOrgRoutes.listOrgKits("org1"),
      routes.forgeOrgs.listOrgKits.replace("{orgId}", "org1")
    );
    assert.equal(
      forgeOrgRoutes.deleteOrg("org1"),
      routes.forgeOrgs.deleteOrg.replace("{orgId}", "org1")
    );
    assert.equal(
      forgeOrgRoutes.orgMembers("org1"),
      routes.forgeOrgs.orgMembers.replace("{orgId}", "org1")
    );
    assert.equal(
      forgeOrgRoutes.orgMember("org1", "user1"),
      routes.forgeOrgs.orgMember.replace("{orgId}", "org1").replace("{userId}", "user1")
    );
    assert.equal(forgeOrgRoutes.myOrgInvites(), routes.forgeOrgs.myOrgInvites);
    assert.equal(
      forgeOrgRoutes.acceptOrgInvite("org1"),
      routes.forgeOrgs.acceptOrgInvite.replace("{orgId}", "org1")
    );
    assert.equal(
      forgeOrgRoutes.transferKit("kit1"),
      routes.forgeOrgs.transferKit.replace("{kitId}", "kit1")
    );
    assert.equal(
      forgeOrgRoutes.setKitVisibility("kit1"),
      routes.forgeOrgs.setKitVisibility.replace("{kitId}", "kit1")
    );
  });

  it("marketBackendOrgRoutes produce expected paths", () => {
    const routes = fixture("routes.json");
    assert.equal(
      marketBackendOrgRoutes.adminListUserOrgs("u1"),
      routes.marketBackendOrgs.adminListUserOrgs.replace("{userId}", "u1")
    );
    assert.equal(marketBackendOrgRoutes.adminCreateOrg(), routes.marketBackendOrgs.adminCreateOrg);
    assert.equal(
      marketBackendOrgRoutes.adminDeleteOrg("org1"),
      routes.marketBackendOrgs.adminDeleteOrg.replace("{orgId}", "org1")
    );
    assert.equal(
      marketBackendOrgRoutes.adminListOrgKits("org1"),
      routes.marketBackendOrgs.adminListOrgKits.replace("{orgId}", "org1")
    );
    assert.equal(
      marketBackendOrgRoutes.adminOrgMembers("org1"),
      routes.marketBackendOrgs.adminOrgMembers.replace("{orgId}", "org1")
    );
    assert.equal(
      marketBackendOrgRoutes.adminOrgMember("org1", "u1"),
      routes.marketBackendOrgs.adminOrgMember.replace("{orgId}", "org1").replace("{userId}", "u1")
    );
    assert.equal(
      marketBackendOrgRoutes.adminListUserInvites("u1"),
      routes.marketBackendOrgs.adminListUserInvites.replace("{userId}", "u1")
    );
    assert.equal(
      marketBackendOrgRoutes.adminAcceptInvite("org1", "u1"),
      routes.marketBackendOrgs.adminAcceptInvite.replace("{orgId}", "org1").replace("{userId}", "u1")
    );
    assert.equal(
      marketBackendOrgRoutes.adminTransferKit("kit1"),
      routes.marketBackendOrgs.adminTransferKit.replace("{kitId}", "kit1")
    );
    assert.equal(
      marketBackendOrgRoutes.adminSetKitVisibility("kit1"),
      routes.marketBackendOrgs.adminSetKitVisibility.replace("{kitId}", "kit1")
    );
  });

  it("forgeUploadBackendRequestSchema accepts optional ownerOrgId", () => {
    const base = fixture("forge-upload-backend-request.json");
    forgeUploadBackendRequestSchema.parse({ ...base, ownerOrgId: "org_01HXYZ" });
    forgeUploadBackendRequestSchema.parse(base); // still valid without ownerOrgId
  });

  it("entitlement fixture satisfies its schema", () => {
    entitlementSchema.parse(fixture("entitlement.json"));
  });

  it("kit pricing metadata defaults to free/USD/default-license", () => {
    const parsed = kitPricingMetadataSchema.parse({});
    assert.equal(parsed.pricing, "free");
    assert.equal(parsed.currency, "USD");
    assert.equal(parsed.licenseType, "default");
  });

  it("set-pricing and grant requests parse", () => {
    setKitPricingRequestSchema.parse({
      actorUserId: "u1",
      pricing: "paid",
      priceModel: "subscription",
      priceCents: 999,
      interval: "month"
    });
    grantEntitlementRequestSchema.parse({
      userId: "u1",
      source: "admin_grant",
      licenseVersion: DEFAULT_KIT_LICENSE_VERSION,
      licenseAcceptedAt: "2026-06-15T00:00:00.000Z",
      licenseTextSnapshot: "..."
    });
  });

  it("marketBackendPricingRoutes produce expected paths", () => {
    const routes = fixture("routes.json");
    assert.equal(
      marketBackendPricingRoutes.adminSetKitPricing("kit1"),
      routes.marketBackendPricing.adminSetKitPricing.replace("{kitId}", "kit1")
    );
    assert.equal(
      marketBackendPricingRoutes.adminListUserEntitlements("u1"),
      routes.marketBackendPricing.adminListUserEntitlements.replace("{userId}", "u1")
    );
    assert.equal(
      marketBackendPricingRoutes.adminGetEntitlement("kit1", "u1"),
      routes.marketBackendPricing.adminGetEntitlement
        .replace("{kitId}", "kit1")
        .replace("{userId}", "u1")
    );
    assert.equal(
      marketBackendPricingRoutes.adminGrantEntitlement("kit1"),
      routes.marketBackendPricing.adminGrantEntitlement.replace("{kitId}", "kit1")
    );
    assert.equal(
      marketBackendPricingRoutes.adminLicensedPackage("kit1"),
      routes.marketBackendPricing.adminLicensedPackage.replace("{kitId}", "kit1")
    );
    assert.equal(forgePricingRoutes.myEntitlements(), routes.forgePricing.myEntitlements);
    assert.equal(
      forgePricingRoutes.licensedPackage("my-kit"),
      routes.forgePricing.licensedPackage.replace("{slug}", "my-kit")
    );
  });

  it("market service licensed-package route + auth header", () => {
    const routes = fixture("routes.json");
    assert.equal(
      marketServiceRoutes.licensedPackage("my-kit"),
      routes.marketService.licensedPackage.replace("{slug}", "my-kit")
    );
    assert.equal(
      marketServiceRoutes.licensedPackage("a/b"),
      "/api/forge/service/kits/a%2Fb/licensed-package"
    );
    assert.equal(marketServiceAuthHeader, "x-agentkit-service-key");
  });

  it("service licensed-package request/response schemas + error enum", () => {
    // Request asserts userId; kitId optional.
    serviceLicensedPackageRequestSchema.parse({ userId: "user_1" });
    serviceLicensedPackageRequestSchema.parse({ userId: "user_1", kitId: "kit_1" });
    assert.throws(() => serviceLicensedPackageRequestSchema.parse({}));
    assert.throws(() => serviceLicensedPackageRequestSchema.parse({ userId: "" }));

    // Response = the user-authed licensed-package payload + resolved kit context.
    serviceLicensedPackageResponseSchema.parse({
      kitId: "kit_1",
      userId: "user_1",
      entitlementId: "ent_1",
      fileName: "my-kit.agentkit.zip",
      contentBase64: "UEs=",
      sha256: "abc",
      licenseVersion: DEFAULT_KIT_LICENSE_VERSION,
      watermark: {
        entitlementId: "ent_1",
        userId: "user_1",
        kitId: "kit_1",
        grantedAt: "2026-06-18T00:00:00.000Z",
        hash: "deadbeef"
      },
      slug: "my-kit",
      pricing: "paid",
      downloadable: false,
      onlineOnly: true
    });

    // Error enum members.
    for (const code of [
      "unconfigured",
      "unauthorized",
      "not_entitled",
      "not_found",
      "invalid_request",
      "backend_unavailable"
    ]) {
      serviceLicensedPackageErrorSchema.parse(code);
    }
    assert.throws(() => serviceLicensedPackageErrorSchema.parse("nope"));
  });

  it("market service entitled-kits route (no slug param)", () => {
    const routes = fixture("routes.json");
    assert.equal(marketServiceRoutes.entitledKits(), routes.marketService.entitledKits);
    assert.equal(marketServiceRoutes.entitledKits(), "/api/forge/service/me/entitled-kits");
  });

  it("service entitled-kits request/response schemas + error enum", () => {
    // Request asserts userId only.
    serviceEntitledKitsRequestSchema.parse({ userId: "user_1" });
    assert.throws(() => serviceEntitledKitsRequestSchema.parse({}));
    assert.throws(() => serviceEntitledKitsRequestSchema.parse({ userId: "" }));

    // Response = browser-safe protected-kit list (name/slug/marketKitId only).
    serviceEntitledKitsResponseSchema.parse({ kits: [] });
    serviceEntitledKitsResponseSchema.parse({
      kits: [{ marketKitId: "kit_1", slug: "my-kit", name: "My Kit" }]
    });
    // Must NOT carry entitlement internals — extra keys are stripped, but the
    // required public fields are enforced.
    assert.throws(() =>
      serviceEntitledKitsResponseSchema.parse({ kits: [{ slug: "x", name: "y" }] })
    );

    for (const code of ["unconfigured", "unauthorized", "invalid_request", "backend_unavailable"]) {
      serviceEntitledKitsErrorSchema.parse(code);
    }
    assert.throws(() => serviceEntitledKitsErrorSchema.parse("not_entitled"));
  });

  it("favorite fixture and request schemas validate", () => {
    favoriteSchema.parse(fixture("favorite.json"));
    addFavoriteRequestSchema.parse({ slug: "my-kit" });
    addFavoriteRequestSchema.parse({ kitId: "kit1" });
    assert.throws(() => addFavoriteRequestSchema.parse({}));
    listFavoritesResponseSchema.parse({ items: [fixture("favorite.json")] });
  });

  it("favorites routes produce expected paths", () => {
    const routes = fixture("routes.json");
    assert.equal(
      marketBackendFavoritesRoutes.adminListUserFavorites("u1"),
      routes.marketBackendFavorites.adminListUserFavorites.replace("{userId}", "u1")
    );
    assert.equal(
      marketBackendFavoritesRoutes.adminAddUserFavorite("u1"),
      routes.marketBackendFavorites.adminAddUserFavorite.replace("{userId}", "u1")
    );
    assert.equal(
      marketBackendFavoritesRoutes.adminRemoveUserFavorite("u1", "kit1"),
      routes.marketBackendFavorites.adminRemoveUserFavorite
        .replace("{userId}", "u1")
        .replace("{kitId}", "kit1")
    );
    assert.equal(forgeFavoritesRoutes.favorites(), routes.forgeFavorites.favorites);
    assert.equal(
      forgeFavoritesRoutes.favorite("kit1"),
      routes.forgeFavorites.favorite.replace("{kitId}", "kit1")
    );
    assert.equal(browserFavoritesRoutes.favorites(), routes.browserFavorites.favorites);
    assert.equal(
      browserFavoritesRoutes.favorite("kit1"),
      routes.browserFavorites.favorite.replace("{kitId}", "kit1")
    );
  });

  it("audit event fixture and query/response schemas validate", () => {
    auditEventSchema.parse(fixture("audit-event.json"));
    listAuditLogsResponseSchema.parse({ items: [fixture("audit-event.json")] });
    listAuditLogsResponseSchema.parse({
      items: [fixture("audit-event.json")],
      nextToken: "abc"
    });
    listAuditLogsQuerySchema.parse({});
    listAuditLogsQuerySchema.parse({
      actorUserId: "u1",
      targetType: "kit",
      targetId: "kit1",
      action: "kit.hidden",
      since: "2026-01-01T00:00:00.000Z",
      limit: 50
    });
    assert.throws(() => auditActionSchema.parse("not.an.action"));
    assert.throws(() => listAuditLogsQuerySchema.parse({ limit: 0 }));
  });

  it("audit routes produce expected paths", () => {
    const routes = fixture("routes.json");
    assert.equal(
      marketBackendAuditRoutes.adminListAuditLogs(),
      routes.marketBackendAudit.adminListAuditLogs
    );
    assert.equal(browserAuditRoutes.auditLogs(), routes.browserAudit.auditLogs);
  });

  it("organizations accept Stripe payout fields", () => {
    const org = organizationSchema.parse({
      orgId: "org1",
      slug: "acme",
      displayName: "Acme",
      type: "team",
      ownerUserId: "u1",
      stripeAccountId: "acct_123",
      chargesEnabled: true,
      payoutsEnabled: true,
      payoutOnboardedAt: "2026-06-16T00:00:00.000Z",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z"
    });
    assert.equal(org.stripeAccountId, "acct_123");
    assert.equal(org.payoutsEnabled, true);
  });

  it("seller-payout routes + set-stripe-account schema", () => {
    assert.equal(orgPayoutRoutes.beginOnboarding("org1"), "/api/orgs/org1/payouts/onboard");
    assert.equal(orgPayoutRoutes.payoutStatus("org1"), "/api/orgs/org1/payouts/status");
    assert.equal(
      marketBackendOrgRoutes.adminSetOrgStripeAccount("org1"),
      "/admin/orgs/org1/stripe-account"
    );
    assert.equal(
      marketBackendOrgRoutes.adminOrgPayoutStatus("org1"),
      "/admin/orgs/org1/payout-status"
    );
    assert.equal(
      marketBackendOrgRoutes.adminOrgByStripeAccount("acct_1"),
      "/admin/orgs/by-stripe-account/acct_1"
    );
    setOrgStripeAccountRequestSchema.parse({
      stripeAccountId: "acct_1",
      chargesEnabled: false,
      payoutsEnabled: false
    });
    assert.throws(() => setOrgStripeAccountRequestSchema.parse({ chargesEnabled: true, payoutsEnabled: true }));
  });

  it("auto fixtures satisfy their schemas", () => {
    autoRunSchema.parse(fixture("auto-run.json"));
    autoApprovalSchema.parse(fixture("auto-approval.json"));
    autoScheduleSchema.parse(fixture("auto-schedule.json"));
    publicAutoWebhookSchema.parse(fixture("auto-webhook.json"));
  });

  it("auto status + trigger enums and error codes", () => {
    for (const s of ["queued", "running", "succeeded", "failed", "canceled", "budget_exceeded"]) {
      autoRunStatusSchema.parse(s);
    }
    assert.throws(() => autoRunStatusSchema.parse("partial"));
    for (const t of ["on_demand", "schedule", "webhook"]) runTriggerSchema.parse(t);
    for (const code of [
      "invalid_request",
      "approval_denied",
      "insufficient_balance",
      "not_found",
      "inputs_unconfigured",
      "unauthorized",
      "internal_auth_unconfigured"
    ]) {
      autoErrorCodeSchema.parse(code);
    }
    assert.throws(() => autoErrorCodeSchema.parse("nope"));
  });

  it("network policy union accepts deny_all and allowlist", () => {
    networkPolicySchema.parse({ mode: "deny_all" });
    networkPolicySchema.parse({ mode: "allowlist", hosts: ["api.example.com", "*.example.com"] });
    assert.throws(() => networkPolicySchema.parse({ mode: "allowlist" }));
    assert.throws(() => networkPolicySchema.parse({ mode: "other" }));
  });

  it("create-run + create-approval requests parse", () => {
    createAutoRunRequestSchema.parse({
      kitRef: { source: "local", localKitId: "k1" },
      prompt: "do it",
      budgetCents: 100
    });
    createAutoApprovalRequestSchema.parse({
      kitRef: { source: "market", marketKitId: "k1" },
      maxBudgetCents: 500
    });
    // kitRef refinement: market requires marketKitId.
    assert.throws(() =>
      createAutoApprovalRequestSchema.parse({ kitRef: { source: "market" }, maxBudgetCents: 1 })
    );
  });

  it("webhook secret is never in list/get; create response carries one-time plaintext", () => {
    // The public projection has no secretHash and no secret.
    const pub = publicAutoWebhookSchema.parse(fixture("auto-webhook.json"));
    assert.ok(!("secretHash" in pub));
    assert.ok(!("secret" in pub));
    assert.equal(typeof pub.ingestUrl, "string");
    // publicAutoWebhookSchema strips secretHash even if present (zod .omit + strip).
    const stripped = publicAutoWebhookSchema.parse({
      ...fixture("auto-webhook.json"),
      secretHash: "deadbeef"
    });
    assert.ok(!("secretHash" in stripped));
    // The create response is the ONLY shape carrying the one-time plaintext secret.
    const created = createAutoWebhookResponseSchema.parse({
      ...fixture("auto-webhook.json"),
      secret: "whsec_plaintext_shown_once"
    });
    assert.equal(created.secret, "whsec_plaintext_shown_once");
    assert.ok(!("secretHash" in created));
    // The persisted record schema DOES carry secretHash (server-internal only).
    autoWebhookSchema.parse({
      id: "wh1",
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      approvalId: "a1",
      budgetCents: 100,
      model: "claude-sonnet-4-6",
      enabled: true,
      secretHash: "deadbeef",
      createdAt: "2026-06-20T00:00:00.000Z",
      lastFiredAt: null,
      lastRunId: null,
      lastError: null,
      fireCount: 0
    });
  });

  it("auto route builders produce expected paths", () => {
    const routes = fixture("routes.json");
    assert.equal(autoRoutes.approvals(), routes.auto.approvals);
    assert.equal(autoRoutes.revokeApproval("a1"), routes.auto.revokeApproval.replace("{id}", "a1"));
    assert.equal(autoRoutes.run("r1"), routes.auto.run.replace("{id}", "r1"));
    assert.equal(autoRoutes.cancelRun("r1"), routes.auto.cancelRun.replace("{id}", "r1"));
    assert.equal(autoRoutes.runInputsUploadUrl(), routes.auto.runInputsUploadUrl);
    assert.equal(autoRoutes.schedule("s1"), routes.auto.schedule.replace("{id}", "s1"));
    assert.equal(autoRoutes.webhook("w1"), routes.auto.webhook.replace("{id}", "w1"));

    assert.equal(forgeAutoRoutes.runs(), routes.forgeAuto.runs);
    assert.equal(
      forgeAutoRoutes.revokeApproval("a1"),
      routes.forgeAuto.revokeApproval.replace("{id}", "a1")
    );
    assert.equal(forgeAutoRoutes.webhook("w1"), routes.forgeAuto.webhook.replace("{id}", "w1"));

    assert.equal(
      autoHookRoutes.ingest("w1"),
      routes.autoHooks.ingest.replace("{webhookId}", "w1")
    );
    assert.equal(autoInternalRoutes.resolveContext(), routes.autoInternal.resolveContext);
    assert.equal(autoInternalRoutes.sweep(), routes.autoInternal.sweep);

    assert.equal(autoWebhookSecretHeader, "x-auto-webhook-secret");
    assert.equal(autoInternalServiceKeyHeader, "x-service-key");
  });

  it("environments.json satisfies the service manifest schema", () => {
    const environments = JSON.parse(
      readFileSync(new URL("../environments.json", import.meta.url), "utf8")
    );
    serviceManifestSchema.parse(environments.production);
  });
});
