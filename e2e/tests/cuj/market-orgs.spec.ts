import { test, expect, type Page } from "@playwright/test";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { STORAGE_STATE_PATH, hasRealSession } from "../../global-setup";

// AgentKitMarket orgs / visibility / consumer-surface CUJs.
//
// These tests are PROMOTED → the cuj project runs them on gamma and they now gate
// deploys. Tests also tagged @reversible are prod-safe (read-only, or a fully
// restored round-trip; no money / compute / irreversible writes). The one
// transfer-MUTATION test is gamma-only: kit transfer is a KIT-ownership change
// whose "transfer back to the personal org" reversal is supported but not
// airtight, so we never run the mutation against a real prod kit.
//
// IMPORTANT — why these journeys do not persist a RUN_ID kit:
//   A kit only reaches the PUBLIC catalog after validation + admin approval +
//   publish (CLAUDE.md hard rule #6 — no automatic publishing). The E2E user is
//   NOT a Market admin on prod, so this suite cannot create + publish a throwaway
//   RUN_ID kit there. Visibility / transfer therefore operate on a PRE-EXISTING
//   kit OWNED by the E2E user (publisher name === the E2E display name) when one
//   exists in the catalog, and RESTORE it in place; otherwise the mutating leg
//   self-skips and only the (reversible) surface assertions run. Nothing durable
//   is created, so "cleanup" == restore-in-place (afterAll, best-effort).
//
// UI map (selector/route sources):
//   - Catalog: app/kits/page.tsx (h1 "Published Agent Kits") +
//     components/CatalogExplorer.tsx (Input placeholder "Search kits, publishers,
//     or tags"; ".catalog-results-summary" -> "N kits match") +
//     components/CatalogStatus.tsx (empty "No kits available yet"). Grid =
//     ".kit-grid .kit-card"; per-card publisher link ".kit-card-meta a" (text =
//     publisher name, href "/publishers/{slug}"); kit link "h3 a"
//     (href "/kits/{slug}").
//   - Kit card badges: components/KitCard.tsx ".badge-row .badge"; price =
//     ".badge-teal" (priceLabel: "Free" | "$X" | "$X/mo" | "$X/run"); paid
//     online-only card adds a "Online-only" badge.
//   - Kit detail: app/kits/[slug]/page.tsx ".badge-row" (price ".badge-teal" +
//     "Runs on Auto" (premium/per_invocation) | "Online-only" + "Licensed" |
//     "Custom license" + trust badges).
//   - Kit management: app/kits/[slug]/manage/page.tsx renders
//     components/KitOrgControls.tsx for ANY slug (client page; no per-kit
//     ownership gate on RENDER). h2 "Kit organization settings"; transfer h3
//     "Transfer ownership" (org <select> with option[value=""] "Select
//     organization…", or ".empty-state" when the user has no orgs, button
//     "Transfer kit"); visibility h3 "Kit visibility" (<select> with
//     option[value="private"], button "Set visibility"). Outcome callouts:
//     ".rule-callout" strong "Visibility updated" / "Transfer submitted";
//     ".rule-callout.danger-callout" strong "Update failed" / "Transfer failed".
//   - Kit mutation routes (browser cookie session -> market backend):
//     POST /api/kits/{slug}/visibility  body { kitId, visibility:"public"|"private" }
//     POST /api/kits/{slug}/transfer    body { kitId, targetOrgId }
//     (KitManagePage passes the URL [slug] segment straight through as kitId.)
//   - Orgs: GET /api/orgs -> Organization[] ({ orgId, slug, displayName, type:
//     "personal"|"team" }) proxied to AgentKitProfile.
//   - Purchases: app/purchases/page.tsx — commercial entitlements page when
//     NEXT_PUBLIC_COMMERCE_ENABLED=1 (hosted prod), else an inert PageShell
//     ("My Purchases" + "Purchases are not available on this instance").
//   - Publisher profile: app/publishers/[slug]/page.tsx (PageShell h1 =
//     publisher name; eyebrow "Publisher profile"/"Verified publisher";
//     ".trust-meter" "N public kit(s)"; ".kit-grid .kit-card").

const market = targets.market.replace(/\/$/, "");

// The E2E user's Market publisher name (frozen into publisher snapshots at
// publish time). Kept in lock-step with profile.spec's CANONICAL_NAME and the
// display name market.spec seeds before submitting.
const DISPLAY_NAME = "AgentKit E2E";

// The manage page renders its controls for any slug without creating anything —
// a RUN_ID placeholder lets the surface assertions run even on an empty catalog.
const PLACEHOLDER_SLUG = `${RUN_ID}-manage-probe`;

test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ suite skipped");

// ---------------------------------------------------------------------------
// Cross-test restore bookkeeping (afterAll safety net — never throws).
// ---------------------------------------------------------------------------
let restoreVisibilityPublicSlug: string | null = null;
let restoreOwnershipToPersonal: { slug: string; personalOrgId: string } | null = null;

test.afterAll(async ({ browser }) => {
  if (!hasRealSession()) return;
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  try {
    if (restoreVisibilityPublicSlug) {
      await context.request
        .post(`${market}/api/kits/${encodeURIComponent(restoreVisibilityPublicSlug)}/visibility`, {
          data: { kitId: restoreVisibilityPublicSlug, visibility: "public" }
        })
        .catch(() => undefined);
    }
    if (restoreOwnershipToPersonal) {
      const { slug, personalOrgId } = restoreOwnershipToPersonal;
      await context.request
        .post(`${market}/api/kits/${encodeURIComponent(slug)}/transfer`, {
          data: { kitId: slug, targetOrgId: personalOrgId }
        })
        .catch(() => undefined);
    }
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CatalogState = {
  cards: ReturnType<Page["locator"]>;
  empty: ReturnType<Page["locator"]>;
  count: number;
};

/** Open the public catalog and resolve to either kit cards or the empty state. */
async function openCatalog(page: Page): Promise<CatalogState> {
  await page.goto(`${market}/kits`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  await expect(page.getByRole("heading", { name: "Published Agent Kits" })).toBeVisible();
  const cards = page.locator(".kit-grid .kit-card");
  const empty = page.getByText("No kits available yet");
  await expect(cards.first().or(empty)).toBeVisible({ timeout: 20_000 });
  return { cards, empty, count: await cards.count() };
}

type CatalogCard = { slug: string; name: string; publisher: string; publisherSlug: string };

/** Read the (name, slug, publisher, publisherSlug) tuple off a catalog card. */
async function readCard(card: ReturnType<Page["locator"]>): Promise<CatalogCard | null> {
  const kitLink = card.locator("h3 a").first();
  const pubLink = card.locator(".kit-card-meta a").first();
  const kitHref = await kitLink.getAttribute("href");
  const pubHref = await pubLink.getAttribute("href");
  const slug = kitHref?.split("/").filter(Boolean).pop();
  const publisherSlug = pubHref?.split("/").filter(Boolean).pop();
  if (!slug || !publisherSlug) return null;
  return {
    slug,
    name: (await kitLink.innerText()).trim(),
    publisher: (await pubLink.innerText()).trim(),
    publisherSlug
  };
}

/** First catalog card fully read, or null when the catalog is empty. */
async function firstCatalogCard(page: Page): Promise<CatalogCard | null> {
  const { cards, count } = await openCatalog(page);
  if (count === 0) return null;
  return readCard(cards.first());
}

/** Find a catalog kit OWNED by the E2E user (publisher name === display name). */
async function findOwnedCatalogKit(page: Page): Promise<CatalogCard | null> {
  const { cards, count } = await openCatalog(page);
  for (let i = 0; i < count; i++) {
    const info = await readCard(cards.nth(i));
    if (info && info.publisher === DISPLAY_NAME) return info;
  }
  return null;
}

/** Open a kit's management surface and wait for the org controls to hydrate. */
async function gotoManage(page: Page, slug: string): Promise<void> {
  await page.goto(`${market}/kits/${encodeURIComponent(slug)}/manage`, {
    waitUntil: "domcontentloaded"
  });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  await expect(page.getByRole("heading", { name: "Kit organization settings" })).toBeVisible({
    timeout: 20_000
  });
  // KitOrgControls renders only after the /api/orgs fetch settles.
  await expect(page.getByRole("button", { name: "Set visibility" })).toBeVisible({
    timeout: 20_000
  });
}

/** The visibility <select> (uniquely carries option[value="private"]). */
function visibilitySelect(page: Page) {
  return page.locator("select").filter({ has: page.locator('option[value="private"]') });
}

/** Drive the visibility form and resolve the success/error callout outcome. */
async function setVisibilityViaUi(page: Page, value: "public" | "private"): Promise<"ok" | "err"> {
  await visibilitySelect(page).selectOption(value);
  await page.getByRole("button", { name: "Set visibility" }).click();
  const ok = page.locator(".rule-callout", { hasText: "Visibility updated" });
  const err = page.locator(".rule-callout.danger-callout", { hasText: "Update failed" });
  await expect(ok.or(err).first()).toBeVisible({ timeout: 20_000 });
  return (await ok.isVisible().catch(() => false)) ? "ok" : "err";
}

/** True when a kit with `name` currently appears as a card in the public catalog. */
async function isKitInCatalog(page: Page, name: string): Promise<boolean> {
  await openCatalog(page);
  return (await page.locator(".kit-grid h3 a", { hasText: name }).count()) > 0;
}

type Org = { orgId: string; displayName: string; slug?: string; type?: string };

/** List the signed-in user's orgs via the browser-cookie API (tolerant shape). */
async function listOrgs(page: Page): Promise<Org[]> {
  const res = await page.request.get(`${market}/api/orgs`);
  if (!res.ok()) return [];
  const body = (await res.json().catch(() => null)) as unknown;
  if (Array.isArray(body)) return body as Org[];
  const rec = (body ?? {}) as Record<string, unknown>;
  for (const key of ["items", "orgs"]) if (Array.isArray(rec[key])) return rec[key] as Org[];
  return [];
}

// ===========================================================================
// 1. Kit visibility toggle — private excludes from the catalog, public restores.
// ===========================================================================

test("kit visibility: controls render; owned kit private→hidden→public @reversible", async ({
  page
}) => {
  // Surface assertion (always safe/reversible): the visibility controls render.
  await gotoManage(page, PLACEHOLDER_SLUG);
  await expect(page.getByRole("heading", { name: "Kit visibility" })).toBeVisible();
  await expect(visibilitySelect(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Set visibility" })).toBeVisible();

  // Round-trip leg: only against a kit the E2E user actually owns + that is
  // currently public in the catalog. On prod the E2E user typically owns no
  // published kit (can't publish without admin) — then this leg self-skips.
  const owned = await findOwnedCatalogKit(page);
  test.skip(
    !owned,
    `no catalog kit owned by "${DISPLAY_NAME}" — cannot publish a throwaway kit without admin (hard rule #6)`
  );

  const { slug, name } = owned!;
  expect(await isKitInCatalog(page, name)).toBe(true); // starts public

  // Set PRIVATE via the UI and confirm the kit drops out of the public catalog.
  await gotoManage(page, slug);
  restoreVisibilityPublicSlug = slug; // arm the afterAll restore before mutating
  expect(await setVisibilityViaUi(page, "private")).toBe("ok");
  expect(await isKitInCatalog(page, name)).toBe(false);

  // Restore PUBLIC and confirm it reappears.
  await gotoManage(page, slug);
  expect(await setVisibilityViaUi(page, "public")).toBe("ok");
  expect(await isKitInCatalog(page, name)).toBe(true);
  restoreVisibilityPublicSlug = null; // restored in-band; afterAll no longer needed
});

// ===========================================================================
// 2a. Kit org-transfer controls render (surface only — no mutation).
// ===========================================================================

test("kit transfer: controls render (transfer target or no-orgs state) @reversible", async ({
  page
}) => {
  await gotoManage(page, PLACEHOLDER_SLUG);
  await expect(page.getByRole("heading", { name: "Transfer ownership" })).toBeVisible();

  // Either a target-org <select> (option[value=""] "Select organization…") renders,
  // or the no-orgs empty state — both are valid depending on the user's orgs.
  const transferSelect = page.locator("select").filter({ has: page.locator('option[value=""]') });
  const noOrgs = page.getByText("You have no organizations to transfer this kit to", {
    exact: false
  });
  await expect(transferSelect.or(noOrgs).first()).toBeVisible({ timeout: 20_000 });

  if (await transferSelect.isVisible().catch(() => false)) {
    // When orgs exist the "Transfer kit" button renders (disabled until a target
    // is chosen). We never submit here — that's the gamma-only mutation test.
    await expect(page.getByRole("button", { name: "Transfer kit" })).toBeVisible();
    const myOrgs = await listOrgs(page);
    for (const org of myOrgs.filter((o) => o.type === "team")) {
      await expect(transferSelect.locator(`option`, { hasText: org.displayName }).first()).toHaveCount(
        1
      );
    }
  }
});

// ===========================================================================
// 2b. Kit transfer MUTATION — gamma only (kit-ownership change; restore may not
//     be airtight, so never touch a real prod kit). Transfers an owned kit to a
//     team org, then restores ownership to the personal org.
// ===========================================================================

test("kit transfer: move owned kit to a team org then restore (gamma only)", async ({
  page
}) => {
  test.skip(envName !== "gamma", "gamma-only: kit-ownership transfer is not a clean prod-safe reversal");

  const owned = await findOwnedCatalogKit(page);
  test.skip(!owned, `no catalog kit owned by "${DISPLAY_NAME}" to transfer`);

  const orgs = await listOrgs(page);
  const teamOrg = orgs.find((o) => o.type === "team");
  const personalOrg = orgs.find((o) => o.type === "personal");
  test.skip(!teamOrg, "no team org to transfer into");
  test.skip(!personalOrg, "no personal org to restore ownership to");

  const { slug } = owned!;
  // Arm the afterAll safety restore before any mutation.
  restoreOwnershipToPersonal = { slug, personalOrgId: personalOrg!.orgId };

  // Transfer to the team org via the UI and assert the success callout.
  await gotoManage(page, slug);
  const transferSelect = page.locator("select").filter({ has: page.locator('option[value=""]') });
  await transferSelect.selectOption(teamOrg!.orgId);
  await page.getByRole("button", { name: "Transfer kit" }).click();
  await expect(
    page.locator(".rule-callout", { hasText: "Transfer submitted" }).first()
  ).toBeVisible({ timeout: 20_000 });

  // Restore ownership to the personal org (deterministic, via the API).
  const restore = await page.request.post(
    `${market}/api/kits/${encodeURIComponent(slug)}/transfer`,
    { data: { kitId: slug, targetOrgId: personalOrg!.orgId } }
  );
  expect(restore.ok(), `restore transfer HTTP ${restore.status()}`).toBe(true);
  restoreOwnershipToPersonal = null; // restored in-band
});

// ===========================================================================
// 3. My Purchases page renders (commercial entitlements list, or the inert stub
//    on the free build). Read-only.
// ===========================================================================

test("my purchases page renders (entitlements list or free-build stub) @reversible", async ({
  page
}) => {
  await page.goto(`${market}/purchases`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);

  // Free/self-host build → inert PageShell ("My Purchases" + not-available
  // notice). Hosted commercial build → the real entitlements page (its exact DOM
  // lives in the private package, so assert tolerantly on a purchases heading).
  const purchasesHeading = page.getByRole("heading", { name: /purchases?/i }).first();
  const freeStubNotice = page.getByText("Purchases are not available on this instance");
  await expect(purchasesHeading.or(freeStubNotice).first()).toBeVisible({ timeout: 20_000 });
});

// ===========================================================================
// 4. Premium / catalog badges render on the grid + detail. Read-only. Asserts
//    the badge components render, and (when a premium/paid kit exists) its
//    specialized badge on the detail page.
// ===========================================================================

test("catalog + detail badges render (price / licensed / premium) @reversible", async ({
  page
}) => {
  const { cards, count } = await openCatalog(page);
  test.skip(count === 0, "catalog is empty — no cards to assert badges on");

  // Grid: every KitCard renders a price badge (badge-teal) in its badge-row.
  const firstCard = cards.first();
  await expect(firstCard.locator(".badge-row .badge").first()).toBeVisible();
  await expect(firstCard.locator(".badge-row .badge-teal").first()).toBeVisible();

  // Detail: open the first kit and assert the always-present badges (price +
  // Licensed/Custom license), which proves the detail badge-row renders.
  const first = await readCard(firstCard);
  expect(first).toBeTruthy();
  await page.goto(`${market}/kits/${encodeURIComponent(first!.slug)}`, {
    waitUntil: "domcontentloaded"
  });
  await expect(page.getByRole("heading", { level: 1, name: first!.name })).toBeVisible();
  const badgeRow = page.locator(".badge-row").first();
  await expect(badgeRow.locator(".badge-teal").first()).toBeVisible();
  await expect(badgeRow.getByText(/Licensed|Custom license/).first()).toBeVisible();

  // Specialized badges: locate a premium (price "$X/run") or online-only card in
  // the grid; if present, its detail page must render the matching badge. If none
  // exists, the generic badge assertions above already satisfy this journey.
  let premiumSlug: string | null = null;
  let onlineOnlySlug: string | null = null;
  for (let i = 0; i < count && !(premiumSlug && onlineOnlySlug); i++) {
    const card = cards.nth(i);
    const priceText = (await card.locator(".badge-row .badge-teal").first().innerText().catch(() => "")).trim();
    const hasOnlineOnly = (await card.locator(".badge-row", { hasText: "Online-only" }).count()) > 0;
    const info = await readCard(card);
    if (!info) continue;
    if (!premiumSlug && /\/run$/.test(priceText)) premiumSlug = info.slug;
    if (!onlineOnlySlug && hasOnlineOnly) onlineOnlySlug = info.slug;
  }

  if (premiumSlug) {
    await page.goto(`${market}/kits/${encodeURIComponent(premiumSlug)}`, {
      waitUntil: "domcontentloaded"
    });
    // Premium (per_invocation) kits are run server-side on Auto → "Runs on Auto".
    await expect(page.locator(".badge-row").first().getByText("Runs on Auto")).toBeVisible();
  } else if (onlineOnlySlug) {
    await page.goto(`${market}/kits/${encodeURIComponent(onlineOnlySlug)}`, {
      waitUntil: "domcontentloaded"
    });
    await expect(page.locator(".badge-row").first().getByText("Online-only")).toBeVisible();
  } else {
    test.info().annotations.push({
      type: "note",
      description:
        "no premium/online-only kit in the catalog to assert specialized badges; generic badge components verified"
    });
  }
});

// ===========================================================================
// 5. Publisher profile page lists a seller's published kits. Read-only.
// ===========================================================================

test("publisher profile lists that seller's published kits @reversible", async ({ page }) => {
  const first = await firstCatalogCard(page);
  test.skip(!first, "catalog is empty — no publisher to open");

  await page.goto(`${market}/publishers/${encodeURIComponent(first!.publisherSlug)}`, {
    waitUntil: "domcontentloaded"
  });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);

  // PageShell renders the publisher name as the H1 and a "Publisher"/"Verified"
  // eyebrow; the trust-meter reports the public kit count; the grid lists kits.
  await expect(page.getByRole("heading", { level: 1, name: first!.publisher })).toBeVisible();
  await expect(page.getByText(/public kits?$/).first()).toBeVisible();
  const publisherCards = page.locator(".kit-grid .kit-card");
  await expect(publisherCards.first()).toBeVisible({ timeout: 20_000 });
  // The kit we arrived from must be one of this publisher's listed kits.
  await expect(page.locator(".kit-grid h3 a", { hasText: first!.name }).first()).toBeVisible();
});
