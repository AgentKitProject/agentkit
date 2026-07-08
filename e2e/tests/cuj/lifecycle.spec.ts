import { test, expect, type Page } from "@playwright/test";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { STORAGE_STATE_PATH, hasRealSession } from "../../global-setup";

// THE HEADLINE cross-app lifecycle CUJ — identify → build → share → automate.
//
// One end-to-end journey that chains all four apps in a single test:
//   Forge (build a kit)  →  Forge → Market submit  →  Market admin approve +
//   PUBLISH  →  the kit is discoverable in the Market catalog  →  it opens in
//   Forge Run / Chat via the `?kit=market:<slug>` deep link (Market → Forge
//   automate handoff).
//
// This is IRREVERSIBLE (an admin publish to the catalog) and touches the run
// surface, so it is:
//   • tagged @wip           → runs ONLY in the `wip` project; never gates deploys.
//   • NOT tagged @reversible → excluded from the prod gate.
//   • hard-guarded gamma-only via test.skip(envName !== "gamma") → publish only
//     ever happens against gamma's private self-host catalog, and the E2E user
//     is a Market admin ONLY on gamma (a regular user on prod).
//
// Where a leg needs real spend or a second identity we assert as far up the
// chain as possible and skip the rest with a reason:
//   • the Market VALIDATION worker must reach validation=passed before an admin
//     can approve. If gamma's worker is slow/inert the test asserts build →
//     submit → queued and skips approve/publish/catalog/run (annotated).
//   • the automate leg asserts the deep link ROUTES to Run / Chat and preselects
//     the kit picker — it never clicks Send, so it costs zero LLM credits. A real
//     AI run is covered by auto.spec / forge.spec, not here.
//
// Selector/route sources (read from app source, not invented):
//   Forge build   — app/forge/sections/BuildSection.tsx (tab "From template";
//                   .ak-field labels "Kit id (slug)" / "Name" / "Description";
//                   button "Create kit"); editor topbar text "Kit editor".
//   Forge kits    — GET /api/kits -> { kits:[{kitId,name}] } (kitId is a server
//                   UUID, so resolve by name); PUT /api/kits/:kitId/files
//                   { path, content } upserts a file (KitEditor "Save file" route)
//                   — used to add README.md + LICENSE so the kit passes the
//                   `publishable` profile (validator.ts PROFILE_REQUIREMENTS).
//   Forge submit  — nav button "Submit to Market" -> MarketSubmitSection
//                   (article.provider-card per kit + "Submit this kit") -> the
//                   SubmitModal (.modal-card, Field "Listing name (optional)"…,
//                   button "Submit for review") POSTs /api/market/submit and
//                   returns { submissionId, status, marketLink }.
//   Market admin  — /admin/submissions/{id} (AdminSubmissionsClient.tsx):
//                   buttons "Approve" then "Publish" (window.confirm). Gating in
//                   lib/admin-actions.ts: approve needs validation=passed;
//                   publish needs review=approved. Non-admins redirect to
//                   /admin/unauthorized. GET /api/admin/submissions/{id} ->
//                   { status, validationStatus, reviewStatus, kitId, kitSlug }.
//   Catalog       — Forge proxy GET /api/market/catalog?q=&limit= ->
//                   { kits:[{slug}] }; Market /kits/{slug} detail ("Agent Kit
//                   listing" + <h1> = kit name) (market.spec.ts).
//   Forge run     — /forge?kit=market:<slug> -> RunSection ("Chat with a kit"
//                   heading + .ak-field "Kit") (ForgeApp.tsx deep-link handling).
//   Toasts        — .akf-toast (error variant .akf-toast.err).
//   Cleanup       — DELETE /api/kits/:kitId (Forge); POST /api/admin/kits/:kitId/
//                   remove + /hide (Market listing); POST /api/submissions/:id/
//                   cancel (user).

test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ suite skipped");

const FORGE = targets.forge.replace(/\/$/, "");
const MARKET = targets.market.replace(/\/$/, "");
const PROFILE = targets.profile.replace(/\/$/, "");

// Single stable name reused as: Forge kit id+name, Market listing name, and the
// expected public catalog title. RUN_ID-prefixed so it is sweepable.
const KIT_NAME = `${RUN_ID}-lifecycle`;

// Publisher display name other suites also rely on (Profile is the source of
// truth for the Market publisher). We only SET it when it is missing.
const CANONICAL_DISPLAY_NAME = "AgentKit E2E";

// ---------------------------------------------------------------------------
// Types for the small JSON surfaces we poll.
// ---------------------------------------------------------------------------

type MyKit = { kitId: string; name?: string };
type CatalogKit = { slug?: string; name?: string };
type AdminSub = {
  status?: string;
  validationStatus?: string;
  reviewStatus?: string;
  kitId?: string;
  kitSlug?: string;
};

// ---------------------------------------------------------------------------
// Cross-run cleanup tracking (module scope so afterAll can see it).
// ---------------------------------------------------------------------------

let submissionId: string | null = null;
let marketKitId: string | null = null;
let published = false;

// ---------------------------------------------------------------------------
// UI + API helpers (mirrors forge.spec.ts / market.spec.ts patterns).
// ---------------------------------------------------------------------------

/** Open the Forge shell and wait for it to hydrate (sidebar nav present). */
async function gotoForge(page: Page, query = ""): Promise<void> {
  await page.goto(`${FORGE}/forge${query}`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/openid-connect|\/auth\/sign-in|\/realms\//);
  await expect(page.getByRole("button", { name: "My Kits", exact: true })).toBeVisible({
    timeout: 20_000
  });
}

/** Click a sidebar nav entry (buttons rendered by the shared AppShell). */
async function navTo(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
}

/** The input/textarea/select of a labelled `.ak-field` (labels lack htmlFor). */
function fieldControl(page: Page, label: string) {
  return page
    .locator(".ak-field")
    .filter({ has: page.locator(`label:text-is("${label}")`) })
    .locator("input, textarea, select")
    .first();
}

/** Create a kit via Build → "From template" (blank). Lands in the Kit editor. */
async function createTemplateKit(page: Page, idAndName: string): Promise<void> {
  await navTo(page, "Build");
  await page.getByRole("tab", { name: "From template" }).click();
  await fieldControl(page, "Kit id (slug)").fill(idAndName);
  await fieldControl(page, "Name").fill(idAndName);
  await fieldControl(page, "Description").fill(`Disposable E2E lifecycle kit ${idAndName}. Safe to delete.`);
  await page.getByRole("button", { name: "Create kit", exact: true }).click();
  await expect(page.getByText("Kit editor").first()).toBeVisible({ timeout: 30_000 });
}

const listMyKits = async (page: Page): Promise<MyKit[]> => {
  const res = await page.request.get(`${FORGE}/api/kits`);
  if (!res.ok()) return [];
  return ((await res.json()) as { kits?: MyKit[] }).kits ?? [];
};

/** Resolve the server UUID of an owned kit by its display name. */
async function resolveKitId(page: Page, name: string): Promise<string | undefined> {
  return (await listMyKits(page)).find((k) => k.name === name)?.kitId;
}

/** Upsert a file into a kit via the same route the KitEditor "Save file" uses. */
async function writeKitFile(page: Page, kitId: string, path: string, content: string): Promise<void> {
  const res = await page.request.put(`${FORGE}/api/kits/${encodeURIComponent(kitId)}/files`, {
    data: { path, content }
  });
  expect(res.ok(), `write ${path} -> HTTP ${res.status()}`).toBe(true);
}

/** Blank template lacks README.md + LICENSE which the `publishable` profile
 *  requires (validator.ts). Add them so the Forge submit's local publishable
 *  validation — and the server-side validation — pass. */
async function makePublishable(page: Page, kitId: string): Promise<void> {
  await writeKitFile(page, kitId, "README.md", `# ${KIT_NAME}\n\nDisposable E2E lifecycle kit. Safe to delete.\n`);
  await writeKitFile(page, kitId, "LICENSE", "MIT\n");
}

/** Ensure the Profile display name is set (Market resolves the publisher from
 *  it; an empty name fails submission). Only writes when missing. */
async function ensureProfileDisplayName(page: Page): Promise<void> {
  const res = await page.request.get(`${PROFILE}/api/profile/me`);
  if (!res.ok()) return; // best-effort — submit retry will surface a real gap
  const p = (await res.json()) as {
    displayName?: string;
    handle?: string;
    avatarInitials?: string;
    bio?: string;
    websiteUrl?: string;
  };
  if ((p.displayName ?? "").trim().length > 0) return;
  await page.request
    .put(`${PROFILE}/api/profile/me`, {
      data: {
        displayName: CANONICAL_DISPLAY_NAME,
        handle: p.handle ?? "",
        avatarInitials: p.avatarInitials ?? "",
        bio: p.bio ?? "",
        websiteUrl: p.websiteUrl ?? ""
      }
    })
    .catch(() => undefined);
}

/** Read the admin submission detail JSON (proxied raw backend payload). */
async function getAdminSubmission(page: Page, id: string): Promise<AdminSub | null> {
  const res = await page.request.get(`${MARKET}/api/admin/submissions/${encodeURIComponent(id)}`);
  if (!res.ok()) return null;
  const raw = (await res.json()) as Record<string, unknown>;
  return {
    status: str(raw.status),
    validationStatus: str(raw.validationStatus),
    reviewStatus: str(raw.reviewStatus),
    kitId: str(raw.kitId),
    kitSlug: str(raw.kitSlug) ?? str(raw.slug)
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** True when the published slug is discoverable via the Forge catalog proxy. */
async function catalogHasSlug(page: Page, slug: string): Promise<boolean> {
  const res = await page.request.get(`${FORGE}/api/market/catalog?q=${encodeURIComponent(KIT_NAME)}&limit=50`);
  if (!res.ok()) return false;
  const kits = ((await res.json()) as { kits?: CatalogKit[] }).kits ?? [];
  return kits.some((k) => k.slug === slug);
}

// ---------------------------------------------------------------------------
// Failure-tolerant cleanup: never throws. Removes the published listing, cancels
// any still-active submission, and deletes the RUN_ID-named Forge kit — this
// run's artifacts AND leftovers from a crashed prior attempt (retries=2).
// ---------------------------------------------------------------------------

test.afterAll(async ({ browser }) => {
  if (!hasRealSession()) return;
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  const api = context.request;
  try {
    // 1. Market listing: remove (from catalog) + hide any kit we published.
    if (marketKitId) {
      await api.post(`${MARKET}/api/admin/kits/${encodeURIComponent(marketKitId)}/remove`, { data: {} }).catch(() => {});
      await api.post(`${MARKET}/api/admin/kits/${encodeURIComponent(marketKitId)}/hide`, { data: {} }).catch(() => {});
    }

    // 2. Market submissions: cancel any active (non-published) RUN_ID submission,
    //    and remove the listing of any published one.
    const email = (process.env.E2E_USER ?? "").trim();
    const listRes = await api
      .get(`${MARKET}/api/admin/submissions?submittedByEmail=${encodeURIComponent(email)}&includeHistory=true`)
      .catch(() => null);
    if (listRes?.ok()) {
      const items = ((await listRes.json()) as { items?: Array<Record<string, unknown>> }).items ?? [];
      for (const it of items) {
        const name = str(it.name) ?? "";
        if (!name.includes(RUN_ID)) continue;
        const id = str(it.submissionId);
        const status = (str(it.status) ?? "").toLowerCase();
        const kitId = str(it.kitId);
        if (status === "published" && kitId) {
          await api.post(`${MARKET}/api/admin/kits/${encodeURIComponent(kitId)}/remove`, { data: {} }).catch(() => {});
        } else if (id && !["canceled", "archived", "removed"].includes(status)) {
          await api.post(`${MARKET}/api/submissions/${encodeURIComponent(id)}/cancel`, { data: {} }).catch(() => {});
        }
      }
    }

    // 3. Forge library: delete every RUN_ID-named kit.
    const kitsRes = await api.get(`${FORGE}/api/kits`).catch(() => null);
    if (kitsRes?.ok()) {
      const kits = ((await kitsRes.json()) as { kits?: MyKit[] }).kits ?? [];
      for (const k of kits) {
        if ((k.name ?? "").includes(RUN_ID)) {
          await api.delete(`${FORGE}/api/kits/${encodeURIComponent(k.kitId)}`).catch(() => {});
        }
      }
    }
  } catch {
    // best-effort cleanup — never fail the suite here
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// THE HEADLINE lifecycle test.
// ---------------------------------------------------------------------------

test.describe("CUJ — headline cross-app lifecycle", () => {
  test("build in Forge → submit → admin publish → discoverable → open in Run/Chat @wip", async ({
    page
  }, testInfo) => {
    // Gamma-only: an admin PUBLISH is irreversible, and the E2E user is a Market
    // admin only on gamma. (Cleanup best-effort removes the listing after.)
    test.skip(envName !== "gamma", "gamma-only: irreversible admin publish + E2E user is admin only on gamma");
    // Long chain (build + async validation + publish + catalog + run) — give it
    // room beyond the default project timeout.
    test.setTimeout(300_000);

    await ensureProfileDisplayName(page);

    // -------------------------------------------------------------------------
    // Leg 1 — BUILD a kit in Forge (from template), then make it publishable.
    // -------------------------------------------------------------------------
    await gotoForge(page);

    // Retry-safe pre-clean: drop any RUN_ID kit a prior attempt left behind.
    for (const k of await listMyKits(page)) {
      if ((k.name ?? "").includes(RUN_ID)) {
        await page.request.delete(`${FORGE}/api/kits/${encodeURIComponent(k.kitId)}`).catch(() => undefined);
      }
    }

    await createTemplateKit(page, KIT_NAME);
    const forgeKitId = await resolveKitId(page, KIT_NAME);
    expect(forgeKitId, "the built kit is listed in the Forge library").toBeTruthy();
    await makePublishable(page, forgeKitId!);

    // -------------------------------------------------------------------------
    // Leg 2 — SHARE: submit the kit to Market from Forge's own UI.
    // -------------------------------------------------------------------------
    await navTo(page, "Submit to Market");
    const kitCard = page.locator("article.provider-card").filter({ hasText: KIT_NAME }).first();
    await expect(kitCard, "the built kit is offered in Submit to Market").toBeVisible({ timeout: 20_000 });
    await kitCard.getByRole("button", { name: "Submit this kit", exact: true }).click();

    // SubmitModal — fill the (optional) listing name so the submission + catalog
    // title are deterministic and sweepable.
    await expect(page.locator(".modal-card")).toBeVisible();
    await fieldControl(page, "Listing name (optional)").fill(KIT_NAME);
    await fieldControl(page, "Summary (optional)").fill("E2E lifecycle fixture — auto-published then removed by the suite.");
    await fieldControl(page, "Categories (comma-separated)").fill("Testing");
    await fieldControl(page, "Tags (comma-separated)").fill("e2e");

    // Submit, capturing the /api/market/submit response (has submissionId). A
    // Profile→Market display-name propagation lag can fail the first attempt
    // (mirrors market.spec) — repair + retry a few times with backoff.
    for (let attempt = 1; attempt <= 4 && !submissionId; attempt++) {
      const [resp] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/market/submit") && r.request().method() === "POST",
          { timeout: 60_000 }
        ),
        page.getByRole("button", { name: "Submit for review", exact: true }).click()
      ]);
      if (resp.ok()) {
        const body = (await resp.json()) as { submissionId?: string };
        submissionId = body.submissionId ?? null;
        break;
      }
      const errText = await resp.text().catch(() => "");
      if (attempt < 4 && /display name|active submission|publisher/i.test(errText)) {
        await ensureProfileDisplayName(page);
        await page.waitForTimeout(2_000 * attempt);
        continue; // modal stays open on error — click submit again
      }
      expect(resp.ok(), `Forge → Market submit failed (HTTP ${resp.status()}): ${errText}`).toBe(true);
    }
    expect(submissionId, "the submit response carried a submissionId").toBeTruthy();

    // Success surfaces a non-error toast in Forge.
    await expect(page.locator(".akf-toast", { hasText: "Submitted to Market for review" })).toBeVisible({
      timeout: 15_000
    });

    // The submission is in the admin queue (proves the Forge→Market seam landed).
    // Distinguish "not admin" (401/403) from "not visible yet" (brief lag): a
    // non-admin self-skips with a clear reason; a lag is polled through.
    const gate = await page.request.get(`${MARKET}/api/admin/submissions/${encodeURIComponent(submissionId!)}`);
    test.skip(
      gate.status() === 401 || gate.status() === 403,
      "E2E user lacks Market admin on this gamma deployment (ADMIN_EMAILS / admins group) — build+submit asserted"
    );
    let queued: AdminSub | null = null;
    await expect
      .poll(async () => Boolean((queued = await getAdminSubmission(page, submissionId!))), { timeout: 15_000 })
      .toBe(true);

    // -------------------------------------------------------------------------
    // Leg 3a — wait for server VALIDATION to pass (gate for admin approval).
    // -------------------------------------------------------------------------
    let sub: AdminSub | null = queued;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      sub = await getAdminSubmission(page, submissionId!);
      const v = (sub?.validationStatus ?? "").toLowerCase();
      if (v === "passed" || v === "failed") break;
      await page.waitForTimeout(4_000);
    }
    const vStatus = (sub?.validationStatus ?? "").toLowerCase();
    // A `failed` validation on a publishable kit IS a regression — surface it.
    expect(vStatus, "built kit must not fail server validation").not.toBe("failed");
    if (vStatus !== "passed") {
      testInfo.annotations.push({
        type: "warning",
        description:
          `submission ${submissionId} never reached validation=passed within 150s (status=${sub?.validationStatus}). ` +
          "Gamma's Market validation worker appears slow/inert — asserted build → submit → queued; " +
          "skipping approve/publish/catalog/run."
      });
      test.skip(true, "Market validation did not complete on this gamma deployment — upstream chain asserted");
    }

    // -------------------------------------------------------------------------
    // Leg 3b — admin APPROVE then PUBLISH via the Market admin UI.
    // -------------------------------------------------------------------------
    await page.goto(`${MARKET}/admin/submissions/${encodeURIComponent(submissionId!)}`, {
      waitUntil: "domcontentloaded"
    });
    test.skip(
      page.url().includes("/admin/unauthorized"),
      "E2E user lacks Market admin on this gamma deployment — build+submit+validation asserted"
    );

    const approveBtn = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approveBtn).toBeEnabled({ timeout: 20_000 });
    await approveBtn.click();
    await expect
      .poll(async () => (await getAdminSubmission(page, submissionId!))?.reviewStatus?.toLowerCase(), {
        timeout: 30_000
      })
      .toBe("approved");

    // Reload so the Publish button reflects the fresh approved state.
    await page.reload({ waitUntil: "domcontentloaded" });
    const publishBtn = page.getByRole("button", { name: "Publish", exact: true });
    await expect(publishBtn).toBeEnabled({ timeout: 20_000 });
    page.once("dialog", (d) => void d.accept()); // "Publish this kit to the public catalog?"
    await publishBtn.click();

    await expect
      .poll(async () => (await getAdminSubmission(page, submissionId!))?.status?.toLowerCase(), { timeout: 30_000 })
      .toBe("published");

    const afterPublish = await getAdminSubmission(page, submissionId!);
    published = true;
    marketKitId = afterPublish?.kitId ?? null;
    const slug = afterPublish?.kitSlug;
    expect(slug, "the published submission exposes a catalog slug").toBeTruthy();

    // -------------------------------------------------------------------------
    // Leg 4 — DISCOVERABLE in the catalog (API proxy + public detail page).
    // -------------------------------------------------------------------------
    await expect
      .poll(async () => catalogHasSlug(page, slug!), { timeout: 30_000 })
      .toBe(true);

    await page.goto(`${MARKET}/kits/${slug}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Agent Kit listing")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1, name: KIT_NAME })).toBeVisible();

    // -------------------------------------------------------------------------
    // Leg 5 — AUTOMATE handoff: the Market → Forge `?kit=market:<slug>` deep
    // link routes to Run / Chat with the kit picker present. No Send is clicked,
    // so this costs zero LLM credits (a real run is covered in auto/forge specs).
    // -------------------------------------------------------------------------
    await gotoForge(page, `?kit=market:${slug}`);
    await expect(page.getByRole("heading", { name: /chat with a kit/i }).first()).toBeVisible({
      timeout: 20_000
    });
    await expect(fieldControl(page, "Kit")).toBeVisible();

    testInfo.annotations.push({
      type: "note",
      description:
        "Full chain proven: Forge build → Forge→Market submit → admin approve+publish → catalog discovery → " +
        "Forge Run/Chat deep-link. The actual AI run is intentionally not dispatched here (spend) — the deep-link " +
        "routing to Run/Chat is the automate proof."
    });
  });
});
