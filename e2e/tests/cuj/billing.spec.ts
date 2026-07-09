import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { STORAGE_STATE_PATH, hasRealSession } from "../../global-setup";

// THE MONEY PATH — AgentKitMarket credits + premium (per_invocation) kits + Auto
// v2 run billing. This is the commercial layer: on a FREE/open-core build every
// commercial route is inert (503 `commerce_disabled`) and Auto runs are unmetered
// (`billing.metered === false`) — the tests below then self-skip with a precise
// reason, which is the correct outcome, not a failure.
//
// TAGGING: these tests are PROMOTED — the cuj project runs them on gamma and they
// now gate deploys. Nothing here creates a RUN_ID-named, API-revocable artifact — the
// journeys ACQUIRE/OBSERVE existing catalog + ledger state rather than mint named
// objects, so there is no RUN_ID prefix to apply. The one prod-safe, read-only
// journey (receipt/history render) is additionally @reversible. Everything that
// touches Stripe, a real premium acquire, or real compute is gamma-only
// (`test.skip(envName !== "gamma", …)`) and uses Stripe TEST MODE on gamma — a
// real-money charge must NEVER hit prod.
//
// Several steps are genuinely undrivable from a browser (submitting a Stripe test
// card on the cross-origin checkout.stripe.com page; the Stripe→server webhook;
// the service-key-gated gateway seller-earnings ledger). Per the first-pass brief
// those are `test.skip`-stubbed with the exact infra each needs — documented, not
// faked.
//
// UI map (selectors/routes verified against the app source):
//   market credits page: apps/market-web/app/account/credits/page.tsx
//     - route  `${market}/account/credits`  (h1 "Add Credits", eyebrow "AgentKitAuto")
//     - pack cards: `.flow-card` with a `button` "Buy"; success/cancel banners via
//       `?topup=success|cancelled`; checkout error → `.empty-state` "Checkout failed".
//     - GET  /api/credits/packs → CreditPack[] (503 { error:"commerce_disabled" } when off)
//     - POST /api/credits/checkout {packId} → { url } (client does window.location=url)
//   kit detail + acquire: apps/market-web/app/kits/[slug]/page.tsx +
//     agentkit-commercial …/components/KitAcquireButton.tsx + LicenseModal.tsx
//     - premium badges: getByText("Runs on Auto"); price badge text `$X/run`.
//     - acquire button label (premium) "Get access" → LicenseModal (checkbox
//       "I have read and agree to the license" → confirm "Accept & buy $X/run"
//       or "Accept & grant (admin)"); commerce-off → `.rule-callout` "Available
//       in the hosted marketplace".
//     - granted callout: `.rule-callout` "Acquired" + run-entry anchors
//       "Use in Forge (web)" / "Run on Auto" (href `?kit=market:<slug>&kitId=<id>`).
//     - POST /api/kits/[slug]/acquire (premium = $0 grant); GET /api/me/entitlements → { items:[{kitId,…}] }
//   auto run billing: apps/auto-web/app/sections/AutoSection.tsx
//     - GET /api/auto/billing → { metered, balanceCents, freeMinutesRemaining, … }
//     - runs surface `${auto}/?section=runs` (h3 "Runs"; card `.provider-card`
//       cost line `$x.xx / $y.yy`; h4 "Run detail"; premium receipt "Kit per-run
//       price" + "Total"); POST /api/auto/runs → 402 { error:"insufficient_balance", requiredCents }.

const market = targets.market.replace(/\/$/, "");
const auto = targets.auto.replace(/\/$/, "");

// Optional escape hatch: point the premium journeys at a known per_invocation kit
// slug when catalog auto-discovery can't find one (e.g. a private gamma catalog).
const PREMIUM_KIT_SLUG = process.env.E2E_PREMIUM_KIT_SLUG?.trim();

test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ suite skipped");

// ---------------------------------------------------------------------------
// Types (mirror the app payload shapes)
// ---------------------------------------------------------------------------

type CreditPack = { id: string; label: string; priceCents: number; creditCents: number; currency: string };
type AutoBilling = {
  metered: boolean;
  balanceCents: number;
  freeMinutesRemaining: number;
  freeMinutesPerMonth: number;
  invocationFeeCents: number;
  activeMinuteRateCents: number;
};
type EntitlementItem = { entitlementId?: string; kitId?: string; status?: string; source?: string };

// Entitlements acquired in-test — swept best-effort in afterAll (see note there).
const acquiredEntitlementIds: string[] = [];

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** GET the public credit-pack catalog. `commerceDisabled` when the route 503s
 *  (open-core / Stripe not wired) so callers can skip with a precise reason. */
async function listCreditPacks(
  request: APIRequestContext
): Promise<{ commerceDisabled: boolean; packs: CreditPack[] }> {
  const res = await request.get(`${market}/api/credits/packs`);
  if (res.status() === 503) return { commerceDisabled: true, packs: [] };
  if (!res.ok()) return { commerceDisabled: false, packs: [] };
  const body = (await res.json().catch(() => [])) as CreditPack[];
  return { commerceDisabled: false, packs: Array.isArray(body) ? body : [] };
}

/** The Auto v2 billing snapshot, or null if the endpoint is unreachable. On a
 *  FREE/unmetered deployment `metered` is false (runs cost nothing → no gate). */
async function getAutoBilling(request: APIRequestContext): Promise<AutoBilling | null> {
  const res = await request.get(`${auto}/api/auto/billing`);
  if (!res.ok()) return null;
  return (await res.json().catch(() => null)) as AutoBilling | null;
}

/** The signed-in user's entitlements ("My Purchases"), or [] when unavailable. */
async function listEntitlements(request: APIRequestContext): Promise<EntitlementItem[]> {
  const res = await request.get(`${market}/api/me/entitlements`);
  if (!res.ok()) return [];
  const body = (await res.json().catch(() => ({}))) as { items?: EntitlementItem[] };
  return Array.isArray(body.items) ? body.items : [];
}

/** Discover a PREMIUM (per_invocation) catalog kit's slug. Prefers the
 *  E2E_PREMIUM_KIT_SLUG override; otherwise scans the public catalog for a card
 *  whose price badge reads `…/run` (only per_invocation kits render that). Null
 *  when none is published on this environment → dependent tests self-skip. */
async function discoverPremiumKitSlug(page: Page): Promise<string | null> {
  if (PREMIUM_KIT_SLUG) return PREMIUM_KIT_SLUG;
  await page.goto(`${market}/kits`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Published Agent Kits" })).toBeVisible();
  const cards = page.locator(".kit-grid .kit-card");
  const empty = page.getByText("No kits available yet");
  await expect(cards.first().or(empty)).toBeVisible({ timeout: 20_000 });
  // A premium card carries a `$X/run` price badge; subscription is `/mo`, one-time
  // has no suffix — so `/run` uniquely identifies per_invocation kits.
  const premium = cards.filter({ hasText: /\/run\b/ }).first();
  if (!(await premium.isVisible().catch(() => false))) return null;
  const href = await premium.locator("h3 a").getAttribute("href");
  const slug = href?.split("/").filter(Boolean).pop();
  return slug ?? null;
}

/** Open the market Add-Credits page for the signed-in user. */
async function gotoCredits(page: Page): Promise<void> {
  await page.goto(`${market}/account/credits`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  await expect(page.getByRole("heading", { name: "Add Credits", level: 1 })).toBeVisible();
}

// ---------------------------------------------------------------------------
// journeys
// ---------------------------------------------------------------------------

test.describe("CUJ — Billing (the money path)", () => {
  test.afterAll(async ({ browser }) => {
    // Best-effort sweep. The money-path journeys create no RUN_ID-named object;
    // the only lasting artifact is a premium ACCESS entitlement (a $0 grant, made
    // only on gamma). There is no public browser revoke route, so this DELETE is a
    // tolerant attempt (404 on deployments without one) — never throws, never a
    // real charge is involved. Re-acquiring the same kit is idempotent, so a
    // leftover grant is harmless if the DELETE is a no-op.
    if (!hasRealSession() || acquiredEntitlementIds.length === 0) return;
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    try {
      for (const id of acquiredEntitlementIds) {
        await context.request
          .delete(`${market}/api/me/entitlements/${encodeURIComponent(id)}`)
          .catch(() => undefined);
      }
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------
  // 1. Buyer credit TOP-UP — open buy-credits → Stripe TEST-MODE checkout.
  //    Driveable extent: the redirect to checkout.stripe.com. Submitting the
  //    test card + the webbook credit are a separate (stubbed) test below.
  // -------------------------------------------------------------------------
  test("credit top-up: buy-credits opens Stripe test-mode checkout", async ({ page }) => {
    test.skip(envName !== "gamma", "gamma-only: real Stripe checkout — TEST MODE lives on gamma, never prod");

    const { commerceDisabled, packs } = await listCreditPacks(page.request);
    test.skip(commerceDisabled, "commerce disabled on this deployment (GET /api/credits/packs → 503) — no Stripe credit packs");
    test.skip(packs.length === 0, "no credit packs configured (CREDIT_PACKS / CREDIT_DENOMINATIONS_CENTS unset)");

    await gotoCredits(page);
    // The pack catalog rendered its Buy buttons (not the failure/loading state).
    const buy = page.getByRole("button", { name: "Buy", exact: true }).first();
    await expect(buy).toBeVisible({ timeout: 20_000 });

    // Click Buy → the client POSTs /api/credits/checkout then navigates to the
    // returned Stripe URL. Race the cross-origin redirect against a checkout error
    // (Stripe key not configured surfaces as the "Checkout failed" empty-state).
    await buy.click();
    const checkoutFailed = page.locator(".empty-state", { hasText: "Checkout failed" });
    const outcome = await Promise.race([
      page
        .waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })
        .then(() => "stripe" as const)
        .catch(() => "timeout" as const),
      checkoutFailed
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => "failed" as const)
        .catch(() => "timeout" as const)
    ]);
    test.skip(
      outcome === "failed",
      "checkout could not start (Stripe not configured for this env) — /api/credits/checkout did not return a session URL"
    );
    expect(outcome, "clicking Buy must redirect to Stripe Checkout").toBe("stripe");
    // Test-mode sessions are `cs_test_…`; assert we are on the Stripe-hosted page.
    // No card is entered, so no charge occurs — the abandoned session simply expires.
    await expect(page).toHaveURL(/checkout\.stripe\.com/);
  });

  // -------------------------------------------------------------------------
  // 1b. Credit top-up → balance reflects the purchase. STUB: the paying half is
  //     undrivable from a browser context.
  // -------------------------------------------------------------------------
  test("credit top-up: webhook credits the account balance", async () => {
    test.skip(envName !== "gamma", "gamma-only: real Stripe test-mode purchase");
    test.skip(
      true,
      "Needs infra outside the browser: (1) submit Stripe TEST card 4242 4242 4242 4242 on the cross-origin " +
        "checkout.stripe.com page, then (2) the Stripe `checkout.session.completed` webhook → market → gateway " +
        "`POST /gateway/credits/topup` (sourceRef=stripe-cs-<id>) crediting the ledger. Drive with the Stripe CLI " +
        "(`stripe trigger checkout.session.completed` / `stripe listen`) or a seeded test event, then assert " +
        "GET /api/auto/billing `balanceCents` increased by the pack's creditCents (idempotent on redelivery)."
    );
  });

  // -------------------------------------------------------------------------
  // 2. Premium kit ACQUISITION + entitlement gate. Premium (per_invocation)
  //    acquire is a $0 ACCESS grant (no Stripe) → drivable end-to-end on gamma:
  //    acquire → entitlement created → 'Use in Forge' / 'Run on Auto' deep-link
  //    enabled (gated on the entitlement).
  // -------------------------------------------------------------------------
  test("premium kit acquire → entitlement created → run deep-link enabled", async ({ page }) => {
    test.skip(envName !== "gamma", "gamma-only: grants a real (persistent) entitlement — kept off prod");

    const slug = await discoverPremiumKitSlug(page);
    test.skip(!slug, "no premium (per_invocation) kit published on this env (set E2E_PREMIUM_KIT_SLUG to target one)");

    await page.goto(`${market}/kits/${slug}`, { waitUntil: "domcontentloaded" });
    // Commerce off → the acquire button is replaced by an inert notice.
    test.skip(
      await page.getByText("Available in the hosted marketplace").isVisible().catch(() => false),
      "commerce disabled on this deployment — the paid-kit acquire UI is not mounted"
    );
    // Premium surface: the per-run price badge + the "Runs on Auto" badge.
    await expect(page.getByText(/\/run\b/).first()).toBeVisible();
    await expect(page.getByText("Runs on Auto").first()).toBeVisible();

    // Acquire through the UI: "Get access" → license modal → agree → confirm. The
    // confirm label varies (buyer "Accept & buy $X/run" vs admin "Accept & grant
    // (admin)"), so match tolerantly. This POSTs /api/kits/<slug>/acquire ($0 grant).
    await page.getByRole("button", { name: "Get access", exact: true }).click();
    const modal = page.locator(".license-modal");
    await expect(modal).toBeVisible();
    await modal.locator('input[type="checkbox"]').check();
    await modal.getByRole("button", { name: /Accept & (buy|grant|get)/i }).click();

    // Granted state: the "Acquired" callout renders. It exposes a run deep-link
    // (protected/online-only kit) or a My-Purchases link (downloadable) — assert
    // the granted surface, then the run-entry deep-link when present.
    const granted = page.locator(".rule-callout", { hasText: "Acquired" });
    await expect(granted).toBeVisible({ timeout: 30_000 });

    const runLink = granted.getByRole("link", { name: /Use in Forge \(web\)|Run on Auto/ }).first();
    let entitledKitId: string | undefined;
    if (await runLink.isVisible().catch(() => false)) {
      const href = (await runLink.getAttribute("href")) ?? "";
      // Deep link is entitlement-gated and carries kit=market:<slug>&kitId=<id>.
      expect(href).toContain(`kit=market:${slug}`);
      entitledKitId = new URL(href, market).searchParams.get("kitId") ?? undefined;
    } else {
      // Downloadable premium (rare): the granted callout links to My Purchases.
      await expect(granted.getByRole("link", { name: /My Purchases/ })).toBeVisible();
    }

    // The entitlement now exists server-side (source premium_access / admin_grant).
    const entitlements = await listEntitlements(page.request);
    expect(entitlements.length, "acquire must create an entitlement").toBeGreaterThan(0);
    const mine = entitledKitId
      ? entitlements.find((e) => e.kitId === entitledKitId)
      : entitlements[0];
    expect(mine, "the acquired kit appears in /api/me/entitlements").toBeTruthy();
    if (mine?.entitlementId) acquiredEntitlementIds.push(mine.entitlementId);
  });

  // -------------------------------------------------------------------------
  // 3. Affordability / spend-cap 402 gate. The 402 only manifests on a METERED
  //    deployment when balance < estimated run cost (run start → 402
  //    insufficient_balance BEFORE any compute is dispatched). Forcing that state
  //    deterministically needs a curated fixture — documented below.
  // -------------------------------------------------------------------------
  test("affordability: run start is denied with 402 when balance < run cost", async ({ page }) => {
    test.skip(envName !== "gamma", "gamma-only: would start real (billed) compute on prod");

    const billing = await getAutoBilling(page.request);
    test.skip(!billing, "GET /api/auto/billing unreachable — cannot read the metering state");
    test.skip(
      billing!.metered === false,
      "unmetered deployment (billing.metered=false): run fees are 0 and the affordability 402 gate is inert — a self-host is never gated"
    );
    // Metered, but forcing balance < cost is not something the harness can
    // guarantee without spending / curation, so document the exact fixture:
    test.skip(
      true,
      "Needs a curated fixture on a metered gateway: a signed-in buyer whose ledger balance is BELOW the run " +
        "estimate — either a drained balance, or a premium kit whose perRunRoyaltyCents exceeds the buyer's balance " +
        "(the royalty is added to the estimate and is never waived by the free trial) — plus a standing approval + " +
        "entitlement for it. Then POST /api/auto/runs must return 402 { error:'insufficient_balance', requiredCents } " +
        "before dispatch. The companion per-run BUDGET CEILING (budget > approval ceiling → 403 approval_denied) is " +
        "the auto.spec approval surface. Neither can be forced here without real spend."
    );
  });

  // -------------------------------------------------------------------------
  // 4. Premium royalty accrual — a paid-kit run accrues seller net earnings
  //    (gross − commission), idempotent per run. STUB: requires a COMPLETED
  //    premium run (real compute) + the service-key-gated seller ledger.
  // -------------------------------------------------------------------------
  test("premium royalty accrual: a paid-kit run accrues seller net earnings", async () => {
    test.skip(envName !== "gamma", "gamma-only: requires a real, billed premium run");
    test.skip(
      true,
      "Not drivable from a browser: (1) run a premium (per_invocation) kit to a BILLABLE terminal state on a metered " +
        "gateway (real compute), which accrues the seller's per-run royalty net of commission to the owning org via " +
        "gateway CreditLedgerRepository.accrueRoyalty (idempotent on source_ref=royalty-<runId>); (2) read it back via " +
        "the gateway's service-key-gated GET /gateway/ledger/seller-earnings/pending (x-gateway-service-key, server-only " +
        "— never exposed to the browser or Forge). Verify: netCents = gross − floor(gross*commissionBps/10000), and that " +
        "re-settling the same runId does NOT double-accrue. Drive via a server-side harness with GATEWAY_SERVICE_KEY."
    );
  });

  // -------------------------------------------------------------------------
  // 5. Transaction / receipt history — the buyer sees run-usage debits (Auto run
  //    history: spent/budget per run + the premium receipt itemization). READ-ONLY
  //    and prod-safe, so @reversible. (Credit-PURCHASE history has no dedicated
  //    list UI — see the annotation; the ?topup=success banner is the only cue.)
  // -------------------------------------------------------------------------
  test("receipt history: run-usage debits render in Auto run history @reversible", async ({ page }, testInfo) => {
    await page.goto(`${auto}/?section=runs`, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
    await expect(page.getByRole("heading", { name: "Runs", exact: true, level: 3 })).toBeVisible();

    const cards = page.locator(".provider-card");
    const empty = page.getByText("No runs yet.");
    await expect(cards.first().or(empty)).toBeVisible({ timeout: 20_000 });

    if (await empty.isVisible().catch(() => false)) {
      // No run history yet on this env — the surface itself rendered correctly.
      testInfo.annotations.push({
        type: "note",
        description: "no runs on this env — asserted the empty run-history surface only (run-usage debits need a prior run)"
      });
    } else {
      // Each run card renders its usage debit as `$spent / $budget`.
      const card = cards.first();
      await expect(card).toContainText(/\$\d+\.\d{2}\s*\/\s*\$\d+\.\d{2}/);
      // Open the run: the detail pane repeats spent/budget; a PREMIUM run adds the
      // receipt itemization ("Kit per-run price" + "Total") — asserted tolerantly.
      await card.click();
      await expect(page.getByRole("heading", { name: "Run detail", level: 4 })).toBeVisible();
      await expect(
        page.locator(".results-panel").getByText(/\$\d+\.\d{2}\s*\/\s*\$\d+\.\d{2}/).first()
      ).toBeVisible();
      const royaltyRow = page.getByText("Kit per-run price");
      if (await royaltyRow.isVisible().catch(() => false)) {
        await expect(page.getByText("Total", { exact: true })).toBeVisible();
      }
    }

    // Credit-purchase history: there is no transaction-list UI (only the
    // post-checkout ?topup=success banner on /account/credits). Assert the credits
    // page renders as the buyer's purchase surface; flag the missing history list.
    await gotoCredits(page);
    testInfo.annotations.push({
      type: "note",
      description:
        "credit-PURCHASE history has no dedicated list UI in market-web (only the ?topup=success banner on " +
        "/account/credits). A per-user credit-transaction history view would be needed to fully cover CUJ 5's " +
        "'buyer sees credit purchases' — flagged for a follow-up."
    });
  });
});
