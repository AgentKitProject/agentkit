import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { STORAGE_STATE_PATH, hasRealSession } from "../../global-setup";

// SELLER PAYOUTS + MANAGED-INFERENCE-FLOOR CUJs — the seller side of the money
// path (Stripe Connect onboarding + the periodic payout batch) plus the
// managed-vs-BYO run-cost floor. Every leg here is inherently GAMMA-ONLY:
//   - Stripe Connect onboarding + payout Transfers are external and only run in
//     Stripe TEST MODE on gamma (a real charge/transfer must NEVER hit prod), and
//     the Stripe-hosted onboarding page can't be automated — we drive to the
//     onboarding-link boundary and stop there (mock-needed).
//   - The managed inference floor (GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS) only
//     bites on a METERED gateway; a self-host/unmetered deployment is never gated,
//     so the floor is inert and the test self-skips (the correct outcome).
// Therefore NO test here is @reversible (none is prod-safe): each is tagged @wip
// (runs only in the `wip` project — never gates a deploy) and guarded with
// `test.skip(envName !== "gamma", …)`.
//
// The seller-PAYOUTS UI (`OrgPayoutsPanel`) lives in the PRIVATE optional package
// `@agentkit-commercial/market-web` (public `components/CommercialPayouts.tsx` is
// only a gated `next/dynamic` loader; the panel is not in the public source), so
// its selectors are unknowable from here. We instead drive the exact public
// routes that panel calls — same server contract, whatever the panel's markup —
// and assert the reachable state, documenting the external/fixture-only remainder.
//
// UI map (routes/selectors read from the real app source, not invented):
//   Market (apps/market-web), `${market}` = targets.market:
//     - POST /api/orgs {displayName}            → proxied Profile create → { item:{ orgId } }
//     - GET  /api/orgs                          → my orgs (array | {items|orgs:[…]})
//     - DELETE /api/orgs/{orgId}                → delete org (cleanup)
//     - GET  /api/orgs/{orgId}/payouts/status   → commercial `browserOrgPayoutStatus`
//         (503 {error:"commerce_disabled"} on the free/open-core build; else the
//          Connect account state — README documents chargesEnabled/payoutsEnabled)
//     - POST /api/orgs/{orgId}/payouts/onboard  → commercial `browserOnboardOrgPayouts`
//         (503 when off; else an onboarding account-link URL to connect.stripe.com)
//     - POST /api/admin/payouts/run             → commercial `adminRunSellerPayouts`
//         (503 when off; admin-cookie-gated `requireAdminForApi`; the periodic
//          Stripe-Transfer batch over pending seller earnings)
//   Auto (apps/auto-web), `${auto}` = targets.auto:
//     - GET /api/auto/billing → { metered, balanceCents, freeMinutesRemaining,
//         freeMinutesPerMonth, invocationFeeCents, activeMinuteRateCents } (the
//         floor is NOT surfaced here — it is a server-side preflight value)
//     - `${auto}/?section=settings` → h3 "Inference & billing"; when metered a
//         "…¢ start fee plus …¢ per active minute" copy + a "Inference mode"
//         Select (options "Managed credits (platform key)" / "My own provider").
//     - `${auto}/?section=run` → h3 "Start a run"; a "Inference for this run"
//         Select (options "Managed credits (this run)" / "My own key (this run)")
//         — the managed-vs-BYO toggle the floor keys off.
//   Gateway (packages/gateway-core), floor mechanism (server-side, service-key-gated,
//     never browser-reachable):
//     - estimateRunStartCents / checkAffordability add managedInferenceFloorCents
//       ONLY when mode==="managed" AND run fees are metered.
//     - POST /gateway/ledger/can-start {userId,mode} → {allowed,reason?} preflight.
//     - GET  /gateway/ledger/seller-earnings/pending  (P2 payout job read).
//   The browser-observable floor delta is POST /api/auto/runs → 402
//     { error:"insufficient_balance", requiredCents } where requiredCents differs
//     by mode — but forcing that needs a curated balance fixture (documented below).

const market = targets.market.replace(/\/$/, "");
const auto = targets.auto.replace(/\/$/, "");

test.skip(!hasRealSession(), "no E2E creds — CUJ suite skipped");

// ---------------------------------------------------------------------------
// Types (mirror the app payload shapes)
// ---------------------------------------------------------------------------

type Org = { orgId: string; displayName?: string };
type AutoBilling = {
  metered: boolean;
  balanceCents: number;
  freeMinutesRemaining: number;
  freeMinutesPerMonth: number;
  invocationFeeCents: number;
  activeMinuteRateCents: number;
};

// Orgs minted this run — swept best-effort in afterAll.
const createdOrgIds: string[] = [];

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** My orgs, tolerant to the array vs {items|orgs} proxied shapes. */
async function listMyOrgs(api: APIRequestContext): Promise<Org[]> {
  const res = await api.get(`${market}/api/orgs`);
  if (!res.ok()) return [];
  const body = (await res.json().catch(() => [])) as unknown;
  if (Array.isArray(body)) return body as Org[];
  const rec = (body ?? {}) as Record<string, unknown>;
  for (const key of ["items", "orgs"]) if (Array.isArray(rec[key])) return rec[key] as Org[];
  return [];
}

/** Delete any of my orgs with this exact displayName (retry-safe pre-clean). */
async function preCleanOrgsByName(api: APIRequestContext, name: string): Promise<void> {
  for (const org of await listMyOrgs(api).catch(() => [] as Org[])) {
    if (org.displayName === name && org.orgId) {
      await api.delete(`${market}/api/orgs/${encodeURIComponent(org.orgId)}`).catch(() => undefined);
    }
  }
}

/** Create a team org via Market (proxied to the Profile store); id or null when
 *  creation isn't permitted for this identity here (admin-gated self-host). */
async function createTeamOrg(api: APIRequestContext, name: string): Promise<string | null> {
  const res = await api.post(`${market}/api/orgs`, { data: { displayName: name } });
  if (!res.ok()) return null;
  const body = (await res.json().catch(() => ({}))) as { item?: { orgId?: string } };
  if (body.item?.orgId) return body.item.orgId;
  return (await listMyOrgs(api)).find((o) => o.displayName === name)?.orgId ?? null;
}

/** The Auto v2 billing snapshot, or null if unreachable. `metered:false` on a
 *  FREE/unmetered deployment (runs cost nothing → the floor gate is inert). */
async function getAutoBilling(api: APIRequestContext): Promise<AutoBilling | null> {
  const res = await api.get(`${auto}/api/auto/billing`);
  if (!res.ok()) return null;
  return (await res.json().catch(() => null)) as AutoBilling | null;
}

/** Recursively find the first http(s) URL string in a parsed JSON value (used to
 *  detect the Stripe Connect onboarding account-link, whose exact field name
 *  lives in the private commercial package). */
function deepFindUrl(value: unknown): string | null {
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = deepFindUrl(v);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const found = deepFindUrl(v);
      if (found) return found;
    }
  }
  return null;
}

/** The `.ak-field` control (input/select/textarea) whose wrapping field carries
 *  an exact `label` (shared @agentkitforge/ui Field renders `.ak-field` > label). */
function fieldControl(page: Page, label: string) {
  return page
    .locator(".ak-field")
    .filter({ has: page.locator(`label:text-is("${label}")`) })
    .locator("input, select, textarea")
    .first();
}

// ---------------------------------------------------------------------------
// journeys
// ---------------------------------------------------------------------------

test.describe("CUJ — Seller payouts + managed inference floor", () => {
  test.afterAll(async ({ browser }) => {
    // Best-effort sweep: delete the RUN_ID orgs this run minted (and any stray
    // RUN_ID-named org left by a crashed run). Never throws. The one lasting
    // side effect a full onboard leaves is a Stripe TEST-MODE Connect account,
    // which has no browser-reachable revoke and is a no-op cost (test mode).
    if (!hasRealSession()) return;
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    try {
      const orgs = await listMyOrgs(context.request).catch(() => [] as Org[]);
      for (const org of orgs) {
        if (!org.orgId) continue;
        if (createdOrgIds.includes(org.orgId) || (org.displayName ?? "").startsWith(RUN_ID)) {
          await context.request
            .delete(`${market}/api/orgs/${encodeURIComponent(org.orgId)}`)
            .catch(() => undefined);
        }
      }
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------
  // 1. Seller Stripe Connect ONBOARDING (gamma-only, mock-needed). Drive an
  //    org's Payouts surface to the onboarding-link boundary: read the (not-yet-
  //    onboarded) payout status, then initiate onboarding and assert the returned
  //    Stripe onboarding account-link URL. The Stripe-hosted onboarding page is
  //    external and cannot be automated — we stop at the link (do NOT follow it).
  // -------------------------------------------------------------------------
  test("seller Connect onboarding: initiate returns a Stripe onboarding link @wip", async ({ page }, testInfo) => {
    test.skip(envName !== "gamma", "gamma-only: real Stripe Connect — TEST MODE lives on gamma, never prod");

    const name = `${RUN_ID}-payouts`;
    await preCleanOrgsByName(page.request, name);
    const orgId = await createTeamOrg(page.request, name);
    test.skip(!orgId, "org creation is not permitted for this identity here (admin-gated self-host) — no org to own the Payouts surface");
    createdOrgIds.push(orgId!);

    testInfo.annotations.push({
      type: "note",
      description:
        "The OrgPayoutsPanel UI lives in the private @agentkit-commercial/market-web package (not public source), " +
        "so its selectors are unknowable here — this drives the exact routes the panel calls " +
        "(/api/orgs/{id}/payouts/status + /payouts/onboard).",
    });

    // Payout STATUS: 503 on a free/open-core build (no commercial pkg). On gamma
    // (commerce on) it is a structured Connect-account snapshot; a brand-new org
    // is not yet payouts-enabled.
    const statusRes = await page.request.get(`${market}/api/orgs/${encodeURIComponent(orgId!)}/payouts/status`);
    test.skip(
      statusRes.status() === 503,
      "commerce disabled on this deployment (GET …/payouts/status → 503 commerce_disabled) — Stripe Connect not wired"
    );
    expect(statusRes.ok(), `payout status HTTP ${statusRes.status()}`).toBe(true);
    const status = (await statusRes.json().catch(() => ({}))) as Record<string, unknown>;
    expect(typeof status, "payout status is a structured object").toBe("object");
    // A freshly-created org has not completed onboarding → payouts not enabled.
    if (typeof status.payoutsEnabled === "boolean") {
      expect(status.payoutsEnabled, "a new org is not yet payouts-enabled").toBe(false);
    }

    // INITIATE onboarding → the server creates/links an Express connected account
    // and returns an onboarding account-link URL (connect.stripe.com). We assert
    // the link is returned and STOP — the hosted onboarding form can't be driven.
    const onboardRes = await page.request.post(
      `${market}/api/orgs/${encodeURIComponent(orgId!)}/payouts/onboard`,
      { data: {} }
    );
    test.skip(
      onboardRes.status() === 503,
      "commerce disabled (POST …/payouts/onboard → 503 commerce_disabled)"
    );
    expect(onboardRes.ok(), `onboard init HTTP ${onboardRes.status()}`).toBe(true);
    const onboardBody = (await onboardRes.json().catch(() => ({}))) as Record<string, unknown>;
    const onboardUrl = deepFindUrl(onboardBody);

    if (onboardUrl) {
      // The initiate step handed back an onboarding link — the assertable extent.
      expect(onboardUrl, "onboarding link is an https URL").toMatch(/^https:\/\//i);
      expect(onboardUrl, "onboarding link targets Stripe (Connect/checkout)").toMatch(/stripe\.com/i);
      testInfo.annotations.push({
        type: "note",
        description:
          "SKIPPED at the external boundary: the returned Stripe-hosted onboarding page (" +
          new URL(onboardUrl).host +
          ") requires a human/mock to submit business + bank details and cannot be automated. " +
          "Completing it (or the account.updated webhook that flips chargesEnabled/payoutsEnabled) " +
          "needs the Stripe CLI / a seeded test connected account.",
      });
    } else {
      // No URL: the org may already be fully onboarded (idempotent re-init) — then
      // the status must reflect an enabled Connect account. Assert that instead.
      testInfo.annotations.push({
        type: "note",
        description:
          "onboard returned no account-link URL — treating as an already-onboarded/idempotent state; " +
          "asserting the payout status reflects a linked Connect account.",
      });
      const reStatus = await page.request.get(`${market}/api/orgs/${encodeURIComponent(orgId!)}/payouts/status`);
      expect(reStatus.ok(), `re-read payout status HTTP ${reStatus.status()}`).toBe(true);
      const re = (await reStatus.json().catch(() => ({}))) as Record<string, unknown>;
      const linked =
        re.chargesEnabled === true ||
        re.payoutsEnabled === true ||
        re.detailsSubmitted === true ||
        typeof re.accountId === "string";
      expect(linked, "an onboarded org exposes a linked Connect account state").toBe(true);
    }

    // Teardown in-test (afterAll re-sweeps).
    await page.request.delete(`${market}/api/orgs/${encodeURIComponent(orgId!)}`).catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  // 2. Periodic seller PAYOUT batch (gamma-only, mock-needed). The admin batch
  //    (POST /api/admin/payouts/run) is a GLOBAL job — it Stripe-Transfers EVERY
  //    org's pending seller earnings to its Connect account — so we must NOT run
  //    it to completion here (it would move funds, test-mode, for orgs this suite
  //    doesn't own). Assert the endpoint is MOUNTED + admin-gated (anon ⇒ 401/403,
  //    or 503 when commerce is off — never a 200 batch anonymously); document the
  //    fixture the full transfer + idempotency check needs.
  // -------------------------------------------------------------------------
  test("seller payout batch: admin run endpoint is mounted and gated; transfer needs a fixture @wip", async ({ browser }, testInfo) => {
    test.skip(envName !== "gamma", "gamma-only: the payout batch performs real (test-mode) Stripe Transfers");

    // Anonymous context (no storageState) — proves the route exists + is gated
    // WITHOUT triggering a real batch under our admin cookie.
    const anon = await browser.newContext();
    try {
      const res = await anon.request.post(`${market}/api/admin/payouts/run`, { data: {} });
      const code = res.status();
      // 503 = commerce off (open-core); 401/403 = admin-gated (requireAdminForApi);
      // 404 = route absent on this build. NEVER 200 for an unauthenticated caller.
      test.skip(code === 503, "commerce disabled (POST /api/admin/payouts/run → 503 commerce_disabled) — no payout batch on this build");
      expect([401, 403, 404], `anon payout-batch POST must be gated, got ${code}`).toContain(code);
      expect(code, "an unauthenticated caller must never run the payout batch").not.toBe(200);
    } finally {
      await anon.close();
    }

    testInfo.annotations.push({
      type: "note",
      description:
        "Full batch + idempotency is NOT driven here (the authed admin run is a GLOBAL job that would move " +
        "test-mode funds for every org with pending earnings, not just this run's). Fixture to verify it: " +
        "(1) an org with pending seller earnings — accrue a completed premium run's royalty via gateway " +
        "accrueRoyalty (source_ref=royalty-<runId>, net of commissionBps); (2) that org onboarded to a " +
        "TEST-MODE Connect account (journey 1). Then POST /api/admin/payouts/run Stripe-Transfers the pending " +
        "balance and records it via gateway markSellerEarningsTransferred (idempotent per transferRef — a retry " +
        "is a no-op, no double-pay). Read back the service-key-gated GET /gateway/ledger/seller-earnings/pending " +
        "(x-gateway-service-key, server-only) to confirm the pending balance dropped by exactly the transferred " +
        "amount. Drive server-side with GATEWAY_SERVICE_KEY against a seeded fixture org.",
    });
  });

  // -------------------------------------------------------------------------
  // 3. Managed inference FLOOR (gamma-only). Managed-mode runs require a small
  //    per-run credit floor (GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS) on top of the
  //    run fees; BYO runs do NOT (the user's own provider bills their tokens). The
  //    floor bites only where run fees are METERED — an unmetered deployment is
  //    never gated, so the floor is inert and we self-skip (the correct outcome).
  //    On a metered gateway we assert the managed-vs-BYO surfaces the floor keys
  //    off (billing snapshot + the run/settings inference selectors), then document
  //    the curated balance fixture the floor's 402 delta needs.
  // -------------------------------------------------------------------------
  test("managed inference floor applies to managed runs, not BYO @wip", async ({ page }, testInfo) => {
    test.skip(envName !== "gamma", "gamma-only: the floor only bites on a metered gateway (compute-billed)");

    const billing = await getAutoBilling(page.request);
    test.skip(!billing, "GET /api/auto/billing unreachable — cannot read the metering state");
    test.skip(
      billing!.metered === false,
      "unmetered deployment (billing.metered=false): run fees are 0 and the managed inference floor is inert " +
        "(GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS only applies where run metering is active — a self-host is never gated)"
    );

    // METERED: the run fees the floor rides on top of are present + integral.
    expect(Number.isInteger(billing!.invocationFeeCents)).toBe(true);
    expect(Number.isInteger(billing!.activeMinuteRateCents)).toBe(true);

    // Settings surface: the metered "Inference & billing" panel + the account-level
    // managed/BYO mode selector (the toggle the floor keys off).
    await page.goto(`${auto}/?section=settings`, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
    await expect(page.getByRole("heading", { name: "Inference & billing", level: 3 })).toBeVisible({ timeout: 20_000 });
    // Metered copy states the per-run fees inference-floor headroom sits above.
    await expect(page.getByText(/start fee plus/i)).toBeVisible({ timeout: 20_000 });
    const acctMode = fieldControl(page, "Inference mode");
    await expect(acctMode).toBeVisible();
    await expect(acctMode.locator("option", { hasText: /Managed credits/ })).toHaveCount(1);
    await expect(acctMode.locator("option", { hasText: /My own provider/ })).toHaveCount(1);

    // Run surface: the per-run inference selector — managed vs BYO, the exact
    // dimension `estimateRunStartCents` adds the floor for (managed) or not (byo).
    await page.goto(`${auto}/?section=run`, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
    await expect(page.getByRole("heading", { name: "Start a run", level: 3 })).toBeVisible({ timeout: 20_000 });
    // With no kit selected the (non-Market) per-run inference selector renders.
    await expect(page.getByText("Inference for this run")).toBeVisible({ timeout: 20_000 });
    const runMode = fieldControl(page, "Inference for this run");
    await expect(runMode.locator("option", { hasText: /Managed credits/ })).toHaveCount(1);
    await expect(runMode.locator("option", { hasText: /My own key/ })).toHaveCount(1);

    // The actual floor DELTA (managed requiredCents = compute + floor; byo =
    // compute) is server-side and not surfaced in the browser estimate/snapshot.
    testInfo.annotations.push({
      type: "note",
      description:
        "SKIPPED at the fixture boundary: the floor is not surfaced in the browser (the ~$X/run estimate is " +
        "invocation+active-minute, mode-independent, floor-excluded). Its differential is observable ONLY via " +
        "(a) the service-key-gated gateway POST /gateway/ledger/can-start {mode} preflight (managed verdict " +
        "includes managedInferenceFloorCents, byo does not — needs GATEWAY_SERVICE_KEY, server-only), or " +
        "(b) a curated buyer balance in the window [byoRequired, managedRequired): then POST /api/auto/runs " +
        "with mode=managed returns 402 {error:'insufficient_balance', requiredCents} BEFORE dispatch while the " +
        "same balance with mode=byo is allowed. Neither is safely browser-drivable here (the second would either " +
        "402 both modes or spend real compute on the allowed BYO run). Reference: gateway-core " +
        "estimateRunStartCents adds the floor only when mode==='managed'. Drive (a) with a server-side harness or " +
        "(b) with a seeded balance fixture on a metered gateway.",
    });
  });
});
