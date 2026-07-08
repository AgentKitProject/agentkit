import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { STORAGE_STATE_PATH, hasRealSession } from "../../global-setup";

// AgentKitMarket publish + moderation LIFECYCLE CUJs (the irreversible-heavy
// journeys the read-only market.spec.ts deliberately leaves out).
//
// EVERY test here is tagged @wip → it runs ONLY in the `wip` project until a
// human verifies it; the cuj / prod-cuj / canary gates all exclude @wip, so
// these never gate a deploy. Drop the @wip tag from a test once it is green to
// promote it.
//
// Tag rules honored below:
//   - @reversible (also runs in prod-cuj): journey 2 only — a read-only download
//     of an already-published FREE kit. No writes, no spend, prod-safe.
//   - Everything else is GAMMA-ONLY via `test.skip(envName !== "gamma", …)`:
//     approve / publish / reject / archive / hide-unhide are irreversible admin
//     actions and the E2E user is only an admin on gamma self-host. No money is
//     spent (the fixture kit is FREE), so no Stripe test-mode card is needed.
//
// Cross-run repeatability note (load-bearing): market-core rejects a PUBLISH
// whose package sha256 matches any already-published KitVersion
// (packages/market-core/src/core/routes/index.ts findKitVersionBySha256; the
// self-host adapter never deletes kit_versions rows, so a removed listing does
// NOT free its sha256). The fixture bytes are identical every run, so every
// publishing test appends a UNIQUE trailing ZIP end-of-central-directory comment
// (`uniqueFixtureFile`) — a legal no-op that unzip ignores but that changes the
// sha256 — so publish never collides across runs.
//
// UI map (selectors/routes are read from the real app source):
//   Submit form (components/UserSubmissionForm.tsx via app/submit): the shared
//     @agentkitforge/ui Input/Textarea render labels WITHOUT htmlFor, so fields
//     are located by their name= attribute — input[name="name"|"version"|
//     "categories"|"tags"|"packageFile"], textarea[name="summary"|"description"];
//     submit button getByRole("button",{name:"Submit for validation"}); the
//     failure box is `.danger-state` with "Submission failed". Success navigates
//     to /submissions/{submissionId}.
//   User submission detail (app/submissions/[submissionId] +
//     components/UserSubmissionsClient.tsx): PageShell title "Submission detail";
//     `.detail-sidebar` StatusBadge spans show status/validation/review text
//     (e.g. "failed", "rejected", "published"); validation errors render under
//     "What needs attention"; statusDescription copy e.g. "Validation found
//     issues that need to be fixed before review."
//   Admin submission detail (app/admin/submissions/[submissionId] +
//     components/AdminSubmissionsClient.tsx): PageShell title "Submission";
//     h2 "Review decision"; review-notes Textarea placeholder "Reason for
//     approval or rejection. Required for rejection."; action buttons (exact
//     names) "Approve" (no confirm) / "Reject" / "Publish" / "Remove submission"
//     / "Hide kit" / "Unhide kit" / "Remove listing" — all except Approve pop a
//     native window.confirm(); ActionFeedback shows "Action status" (success) or
//     "Action failed"; requireAdmin() redirects non-admins to /admin/unauthorized.
//   Catalog (app/kits + components/CatalogExplorer.tsx + KitCard.tsx): heading
//     "Published Agent Kits"; search getByPlaceholder("Search kits, publishers,
//     or tags"); cards `.kit-grid .kit-card`, title link `h3 a` → /kits/{slug};
//     price Badge `.badge` renders "Free" for free kits.
//   Kit detail (app/kits/[slug]/page.tsx): eyebrow "Agent Kit listing", h1 = kit
//     name; notFound() unless the kit is a public catalog kit.
//   APIs used directly (same iron-session cookie the UI uses): user
//     GET /api/submissions/{id} → {item}, POST /api/submissions/{id}/cancel;
//     admin GET /api/admin/submissions[?includeHistory=true] → {items},
//     POST /api/admin/kits/{kitId}/remove; download POST /api/kits/{slug}/download
//     → {downloadUrl,fileName}.

const market = targets.market.replace(/\/$/, "");
const profile = targets.profile.replace(/\/$/, "");

const FIXTURE_KIT = fileURLToPath(
  new URL("../../fixtures/e2e-fixture-kit.agentkit.zip", import.meta.url)
);

// Statuses from which a user may still cancel a submission (mirrors
// cancelSubmissionActionState in UserSubmissionsClient.tsx).
const CLOSED_STATUSES = ["published", "archived", "canceled", "removed"];

const ZIP_MAGIC = [0x50, 0x4b]; // "PK"

test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ suite skipped");

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value?: string) => value?.trim().toLowerCase() ?? "";

type SubmissionItem = {
  submissionId?: string;
  name?: string;
  status?: string;
  validationStatus?: string;
  reviewStatus?: string;
  reviewNotes?: string;
  kitId?: string;
  kitSlug?: string;
  version?: string;
};

/** A file payload for setInputFiles with an in-memory buffer. */
type FilePayload = { name: string; mimeType: string; buffer: Buffer };

/**
 * The real fixture bytes with a UNIQUE trailing ZIP EOCD comment appended so the
 * package sha256 differs every run (see the header note) while the extracted kit
 * is byte-identical and still validates as publishable. Safe only when the EOCD
 * sits at the tail with a zero-length comment (verified for this fixture); falls
 * back to the raw bytes otherwise.
 */
function uniqueFixtureFile(tag: string): FilePayload {
  const base = readFileSync(FIXTURE_KIT);
  const eocdOffset = base.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const fallback: FilePayload = { name: `${tag}.agentkit.zip`, mimeType: "application/zip", buffer: base };
  if (eocdOffset < 0 || eocdOffset + 22 !== base.length || base.readUInt16LE(eocdOffset + 20) !== 0) {
    return fallback;
  }
  const comment = Buffer.from(`e2e:${tag}:${Date.now().toString(36)}`, "utf8");
  const out = Buffer.from(base);
  out.writeUInt16LE(comment.length, eocdOffset + 20); // set the EOCD comment length
  return { name: `${tag}.agentkit.zip`, mimeType: "application/zip", buffer: Buffer.concat([out, comment]) };
}

/**
 * A 0-byte package. market-core's validation worker currently does NOT inspect
 * package CONTENTS (services/validation.ts: "@agentkitforge/core validation
 * integration is pending") — so a well-formed but non-kit zip PASSES. The one
 * content-agnostic failure lever a submittable file can hit is the empty-object
 * check (packageSizeBytes === 0 → validationStatus "failed"), so a deliberately
 * empty upload is how we exercise the failed-badge surface today. Revisit to a
 * real non-kit zip once core content validation is wired into the worker.
 */
function malformedZip(tag: string): FilePayload {
  return { name: `${tag}.agentkit.zip`, mimeType: "application/zip", buffer: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// API helpers (drive the same routes the UI does, via the authed cookie jar)
// ---------------------------------------------------------------------------

async function getUserSubmission(request: APIRequestContext, submissionId: string): Promise<SubmissionItem | null> {
  const response = await request.get(`${market}/api/submissions/${encodeURIComponent(submissionId)}`);
  if (!response.ok()) return null;
  const payload = (await response.json()) as { item?: SubmissionItem };
  return payload.item ?? null;
}

async function listMySubmissions(request: APIRequestContext): Promise<SubmissionItem[]> {
  const response = await request.get(`${market}/api/submissions`);
  if (!response.ok()) return [];
  const payload = (await response.json()) as { items?: SubmissionItem[] };
  return Array.isArray(payload.items) ? payload.items : [];
}

/** Admin submission list (admin-cookie route); qs like "?includeHistory=true". */
async function adminList(request: APIRequestContext, qs = ""): Promise<SubmissionItem[]> {
  const response = await request.get(`${market}/api/admin/submissions${qs}`);
  if (!response.ok()) return [];
  const payload = (await response.json()) as { items?: SubmissionItem[] };
  return Array.isArray(payload.items) ? payload.items : [];
}

/** Cancel any still-active e2e-* submissions (this run's + crashed leftovers). */
async function cancelStaleE2eSubmissions(request: APIRequestContext): Promise<void> {
  const items = await listMySubmissions(request).catch(() => [] as SubmissionItem[]);
  for (const item of items) {
    const name = item.name ?? "";
    const cancelable =
      !CLOSED_STATUSES.includes(norm(item.status)) &&
      norm(item.reviewStatus) !== "approved" &&
      norm(item.reviewStatus) !== "rejected";
    if (name.startsWith("e2e-") && item.submissionId && cancelable) {
      await request
        .post(`${market}/api/submissions/${encodeURIComponent(item.submissionId)}/cancel`, { data: {} })
        .catch(() => undefined);
    }
  }
}

/** Poll GET /api/submissions/{id} until `predicate` holds; throws on timeout. */
async function pollUserSubmission(
  request: APIRequestContext,
  submissionId: string,
  predicate: (item: SubmissionItem) => boolean,
  timeoutMs = 60_000
): Promise<SubmissionItem> {
  const start = Date.now();
  let last: SubmissionItem | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await getUserSubmission(request, submissionId);
    if (last && predicate(last)) return last;
    await sleep(2_500);
  }
  throw new Error(
    `submission ${submissionId} never matched (last status=${last?.status} validation=${last?.validationStatus} review=${last?.reviewStatus})`
  );
}

/**
 * Wait for the terminal validation outcome. Returns "passed" | "failed", or
 * "pending" if the validation worker never resolved within the deadline (an
 * environment/worker gap, not an app regression — callers self-skip on it).
 */
async function waitValidationOutcome(
  request: APIRequestContext,
  submissionId: string,
  timeoutMs = 90_000
): Promise<"passed" | "failed" | "pending"> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const item = await getUserSubmission(request, submissionId);
    const validation = norm(item?.validationStatus);
    if (validation === "passed") return "passed";
    if (validation === "failed") return "failed";
    await sleep(2_500);
  }
  return "pending";
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/** Idempotently ensure the Profile display name is set (submission requires it). */
async function ensureProfileDisplayName(page: Page): Promise<void> {
  await page.goto(`${profile}/account/profile`, { waitUntil: "domcontentloaded" });
  const displayName = page.locator('input[name="displayName"]');
  await expect(displayName).toBeVisible({ timeout: 20_000 });
  if ((await displayName.inputValue()).trim().length === 0) {
    await displayName.fill("AgentKit E2E");
    await page.getByRole("button", { name: "Save profile" }).click();
    const saved = page.getByText("Saved", { exact: true });
    const failed = page.getByText("Could not save", { exact: true });
    await expect(saved.or(failed)).toBeVisible();
    if (await failed.isVisible().catch(() => false)) {
      const handle = page.locator('input[name="handle"]');
      if ((await handle.inputValue()).trim().length === 0) {
        await handle.fill("agentkit-e2e");
      }
      await page.getByRole("button", { name: "Save profile" }).click();
      await expect(saved).toBeVisible();
    }
  }
}

/** Fill and submit the /submit form. `file` is a path or an in-memory payload. */
async function fillSubmitForm(page: Page, name: string, version: string, file: string | FilePayload): Promise<void> {
  await page.locator('input[name="name"]').fill(name);
  await page.locator('textarea[name="summary"]').fill("E2E CUJ lifecycle fixture. Managed by the suite.");
  await page.locator('textarea[name="description"]').fill("Automated Playwright CUJ artifact. Safe to remove.");
  await page.locator('input[name="version"]').fill(version);
  await page.locator('input[name="categories"]').fill("Testing");
  await page.locator('input[name="tags"]').fill("e2e");
  await page.locator('input[name="packageFile"]').setInputFiles(file);
  await page.getByRole("button", { name: "Submit for validation" }).click();
}

/** Wait for the submit outcome: navigation to detail, or a form error string. */
async function waitForSubmitOutcome(page: Page): Promise<"navigated" | string> {
  const failureBox = page.locator(".danger-state", { hasText: "Submission failed" });
  const outcome = await Promise.race([
    page.waitForURL(/\/submissions\/[^/?#]+$/, { timeout: 60_000 }).then(() => "navigated" as const),
    failureBox.waitFor({ state: "visible", timeout: 60_000 }).then(() => "failed" as const)
  ]);
  if (outcome === "navigated") return "navigated";
  return (await failureBox.locator("p").first().innerText()).trim();
}

/**
 * Submit the fixture with a bounded retry loop (repairs the two known transient
 * precondition failures: Profile display-name propagation lag and a lingering
 * active duplicate). Returns the new submissionId. Asserts navigation.
 */
async function submitFixture(page: Page, name: string, file: string | FilePayload, version = "0.1.0"): Promise<string> {
  let outcome: "navigated" | string = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(`${market}/submit`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Submit an Agent Kit" })).toBeVisible();
    await fillSubmitForm(page, name, version, file);
    outcome = await waitForSubmitOutcome(page);
    if (outcome === "navigated") break;
    if (attempt < 4 && /display name|active submission/i.test(outcome)) {
      await ensureProfileDisplayName(page);
      await cancelStaleE2eSubmissions(page.request);
      await sleep(2_000 * attempt);
      continue;
    }
    break;
  }
  expect(outcome, `submit flow error: ${outcome}`).toBe("navigated");
  return page.url().split("/").filter(Boolean).pop()!;
}

/**
 * Open the admin submission detail page. Self-skips (env-config gap, not a bug)
 * when the E2E user lacks market admin on this deployment. Resolves once the
 * "Review decision" panel has rendered.
 */
async function gotoAdminSubmission(page: Page, submissionId: string): Promise<void> {
  await page.goto(`${market}/admin/submissions/${encodeURIComponent(submissionId)}`, { waitUntil: "domcontentloaded" });
  test.skip(
    page.url().includes("/admin/unauthorized"),
    "E2E user lacks market admin on this deployment (ADMIN_EMAILS / admins group)"
  );
  await expect(page).not.toHaveURL(/auth\/sign-in/);
  await expect(page.getByRole("heading", { name: "Review decision" })).toBeVisible({ timeout: 20_000 });
}

/** From an open admin submission detail page: Approve, then Publish, then wait
 *  until the server reports the kit published. Returns the published kitId.
 *  NOTE: the submission endpoint carries `kitId` but NOT a slug (the slug lives
 *  on the public kit) — resolve the slug separately via `resolveSlugByName`. */
async function approveThenPublish(page: Page, submissionId: string): Promise<string> {
  const approveBtn = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approveBtn).toBeEnabled({ timeout: 30_000 });
  await approveBtn.click(); // Approve has no confirm dialog
  await expect(page.getByText("Action status")).toBeVisible({ timeout: 20_000 });

  const publishBtn = page.getByRole("button", { name: "Publish", exact: true });
  await expect(publishBtn).toBeEnabled({ timeout: 20_000 });
  page.once("dialog", (dialog) => void dialog.accept()); // Publish confirms
  await publishBtn.click();

  const published = await pollUserSubmission(
    page.request,
    submissionId,
    (item) => norm(item.status) === "published" && Boolean(item.kitId),
    60_000
  );
  return published.kitId!;
}

/** Resolve a freshly-published kit's slug via the authed catalog search (the
 *  submission API never exposes a slug). The catalog list link href is
 *  /kits/{slug}; finding the kit here doubles as public-catalog-inclusion proof.
 *  Must be called while the kit is public (i.e. before any hide). */
async function resolveSlugByName(page: Page, kitName: string): Promise<string> {
  const link = page.locator(".kit-grid h3 a", { hasText: kitName }).first();
  await expect
    .poll(
      async () => {
        await page.goto(`${market}/kits`, { waitUntil: "domcontentloaded" });
        await page.getByPlaceholder("Search kits, publishers, or tags").fill(kitName);
        return link.count();
      },
      { timeout: 30_000, intervals: [1_000, 2_000, 3_000, 5_000] }
    )
    .toBeGreaterThan(0);
  const href = (await link.getAttribute("href")) ?? "";
  const slug = href.split("/").filter(Boolean).pop() ?? "";
  expect(slug, "resolved a slug from the published catalog listing").toBeTruthy();
  return slug;
}

/** Best-effort: confirm a slug is downloadable and returns real zip bytes. */
async function expectDownloadableZip(request: APIRequestContext, slug: string): Promise<void> {
  const dl = await request.post(`${market}/api/kits/${encodeURIComponent(slug)}/download`);
  expect(dl.ok(), `download-url HTTP ${dl.status()}`).toBe(true);
  const body = (await dl.json()) as { downloadUrl?: string; fileName?: string };
  expect(body.downloadUrl, "download response carries a downloadUrl").toBeTruthy();
  const fileName = body.fileName ?? body.downloadUrl!.split("?")[0].split("/").pop() ?? "";
  expect(fileName, "download filename ends with .zip").toMatch(/\.zip$/);
  const zip = await request.get(body.downloadUrl!);
  expect(zip.status(), "presigned download GET is 200").toBe(200);
  const bytes = await zip.body();
  expect(bytes.length).toBeGreaterThan(0);
  expect([bytes[0], bytes[1]], "body starts with the PK zip magic").toEqual(ZIP_MAGIC);
}

// ---------------------------------------------------------------------------
// Suite-wide tolerant cleanup: cancel active e2e-* submissions and (gamma admin)
// remove any e2e published/hidden listings THIS run created. Never throws.
// ---------------------------------------------------------------------------

test.afterAll(async ({ browser }) => {
  if (!hasRealSession()) return;
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  try {
    await cancelStaleE2eSubmissions(context.request);
    if (envName === "gamma") {
      const items = await adminList(context.request, "?includeHistory=true").catch(() => [] as SubmissionItem[]);
      for (const item of items) {
        const isThisRun = (item.name ?? "").startsWith(RUN_ID);
        const isLive = ["published", "hidden"].includes(norm(item.status));
        if (isThisRun && item.kitId && isLive) {
          await context.request
            .post(`${market}/api/admin/kits/${encodeURIComponent(item.kitId)}/remove`, { data: {} })
            .catch(() => undefined);
        }
      }
    }
  } catch {
    // best-effort — never fail the suite in teardown
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// 1. FULL publish lifecycle (gamma-only): submit → validation_passed → approve
//    → publish → public catalog inclusion → download the .agentkit.zip.
// ---------------------------------------------------------------------------

test("full publish lifecycle: submit, validate, approve, publish, catalog, download @wip", async ({ page }) => {
  test.skip(envName !== "gamma", "gamma-only: approve/publish are irreversible admin actions");
  const kitName = `${RUN_ID}-pub`;

  await ensureProfileDisplayName(page);
  await cancelStaleE2eSubmissions(page.request);

  const submissionId = await submitFixture(page, kitName, uniqueFixtureFile(kitName));

  const validation = await waitValidationOutcome(page.request, submissionId);
  test.skip(validation === "pending", "validation worker did not resolve on this env");
  expect(validation, "the fixture kit is a valid publishable kit").toBe("passed");

  await gotoAdminSubmission(page, submissionId);
  const kitId = await approveThenPublish(page, submissionId);
  expect(kitId).toBeTruthy();

  // Resolve the published slug via the catalog search — this doubles as the
  // public-catalog-inclusion proof (the kit surfaces in the SSR list by name).
  const slug = await resolveSlugByName(page, kitName);

  // Kit detail page: 404s unless the kit is a public catalog kit, so a rendered
  // listing is a second inclusion proof.
  await page.goto(`${market}/kits/${slug}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Agent Kit listing")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: kitName })).toBeVisible();

  // Download the published free package: 200 + real zip bytes.
  await expectDownloadableZip(page.request, slug);
});

// ---------------------------------------------------------------------------
// 2. Free public kit DOWNLOAD happy-path (@reversible): a signed-in user
//    downloads an already-published FREE catalog kit. Read-only, prod-safe.
// ---------------------------------------------------------------------------

test("signed-in user downloads a free published catalog kit @reversible @wip", async ({ page }) => {
  await page.goto(`${market}/kits`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Published Agent Kits" })).toBeVisible();
  const cards = page.locator(".kit-grid .kit-card");
  const empty = page.getByText("No kits available yet").or(page.getByText("No kits found"));
  await expect(cards.first().or(empty)).toBeVisible({ timeout: 20_000 });
  test.skip((await cards.count()) === 0, "catalog is empty on this env — no kit to download");

  // A FREE kit shows the literal "Free" price badge (paid kits show a price).
  const freeCard = cards.filter({ has: page.locator(".badge", { hasText: /^Free$/ }) }).first();
  test.skip((await freeCard.count()) === 0, "no FREE kit in the catalog on this env");

  const href = await freeCard.locator("h3 a").getAttribute("href");
  const slug = href?.split("/").filter(Boolean).pop();
  expect(slug, "free kit card exposes a /kits/{slug} link").toBeTruthy();

  await expectDownloadableZip(page.request, slug!);
});

// ---------------------------------------------------------------------------
// 3. Admin REJECT a submission with review notes (gamma-only, terminal).
// ---------------------------------------------------------------------------

test("admin rejects a submission with review notes @wip", async ({ page }) => {
  test.skip(envName !== "gamma", "gamma-only: reject is a terminal admin action");
  const kitName = `${RUN_ID}-reject`;

  await ensureProfileDisplayName(page);
  await cancelStaleE2eSubmissions(page.request);

  const submissionId = await submitFixture(page, kitName, uniqueFixtureFile(kitName));
  await gotoAdminSubmission(page, submissionId);

  // Reject requires review notes (rejectActionState). Filling the notes textarea
  // fires the onChange that enables the button.
  const notes = `${RUN_ID} automated rejection: E2E terminal reject journey. Safe to ignore.`;
  await page.getByPlaceholder("Reason for approval or rejection. Required for rejection.").fill(notes);

  const rejectBtn = page.getByRole("button", { name: "Reject", exact: true });
  await expect(rejectBtn).toBeEnabled({ timeout: 20_000 });
  page.once("dialog", (dialog) => void dialog.accept()); // Reject confirms
  await rejectBtn.click();
  await expect(page.getByText("Action status")).toBeVisible({ timeout: 20_000 });

  // Server + UI both reflect the terminal rejected review state.
  const rejected = await pollUserSubmission(
    page.request,
    submissionId,
    (item) => norm(item.reviewStatus) === "rejected",
    30_000
  );
  expect(norm(rejected.reviewStatus)).toBe("rejected");
  await expect(page.locator(".detail-sidebar").getByText("rejected").first()).toBeVisible({ timeout: 20_000 });
});

// ---------------------------------------------------------------------------
// 4. Admin HIDE / UNHIDE a published kit (gamma-only). Publishes a fresh,
//    uniquely-hashed fixture, then round-trips catalog visibility.
// ---------------------------------------------------------------------------

test("admin hides then unhides a published kit @wip", async ({ page }) => {
  test.skip(envName !== "gamma", "gamma-only: publish/hide/unhide are irreversible admin actions");
  const kitName = `${RUN_ID}-hide`;

  await ensureProfileDisplayName(page);
  await cancelStaleE2eSubmissions(page.request);

  const submissionId = await submitFixture(page, kitName, uniqueFixtureFile(kitName));
  const validation = await waitValidationOutcome(page.request, submissionId);
  test.skip(validation === "pending", "validation worker did not resolve on this env");
  expect(validation).toBe("passed");

  await gotoAdminSubmission(page, submissionId);
  await approveThenPublish(page, submissionId);

  // Hide: only enabled for a published, non-hidden kit (hideKitActionState).
  const hideBtn = page.getByRole("button", { name: "Hide kit", exact: true });
  await expect(hideBtn).toBeEnabled({ timeout: 20_000 });
  page.once("dialog", (dialog) => void dialog.accept()); // Hide confirms
  await hideBtn.click();
  // Confirm the POST resolved before reading the (async-propagated) new state.
  await expect(page.getByText("Action status")).toBeVisible({ timeout: 20_000 });

  // Once hidden, Unhide flips on (isHiddenKit → true) and Hide flips off. The
  // admin UI does a SINGLE in-place refetch that races gamma's async hidden-status
  // propagation, so poll a FRESH server read (re-navigate) until it reflects.
  await expect
    .poll(
      async () => {
        await gotoAdminSubmission(page, submissionId);
        return page.getByRole("button", { name: "Unhide kit", exact: true }).isEnabled();
      },
      { timeout: 30_000, intervals: [1_000, 2_000, 3_000, 5_000] }
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Hide kit", exact: true })).toBeDisabled();

  // Unhide: restore to the public catalog.
  page.once("dialog", (dialog) => void dialog.accept()); // Unhide confirms
  await page.getByRole("button", { name: "Unhide kit", exact: true }).click();
  await expect(page.getByText("Action status")).toBeVisible({ timeout: 20_000 });

  // Back to published: Hide flips on again, Unhide off — poll a fresh server read.
  await expect
    .poll(
      async () => {
        await gotoAdminSubmission(page, submissionId);
        return page.getByRole("button", { name: "Hide kit", exact: true }).isEnabled();
      },
      { timeout: 30_000, intervals: [1_000, 2_000, 3_000, 5_000] }
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Unhide kit", exact: true })).toBeDisabled();
});

// ---------------------------------------------------------------------------
// 5. Admin ARCHIVE a submission → leaves the default queue, appears with
//    includeHistory (gamma-only). The UI's "Remove submission" button archives
//    the submission (core routes /remove and /archive both call
//    archiveAdminSubmission → status "archived").
// ---------------------------------------------------------------------------

test("admin archives a submission out of the default queue @wip", async ({ page }) => {
  test.skip(envName !== "gamma", "gamma-only: archiving a submission is a terminal admin action");
  const kitName = `${RUN_ID}-arch`;

  await ensureProfileDisplayName(page);
  await cancelStaleE2eSubmissions(page.request);

  const submissionId = await submitFixture(page, kitName, uniqueFixtureFile(kitName));
  await gotoAdminSubmission(page, submissionId);

  // "Remove submission" archives it out of the active queue (kept in history).
  const removeBtn = page.getByRole("button", { name: "Remove submission", exact: true });
  await expect(removeBtn).toBeEnabled({ timeout: 20_000 });
  page.once("dialog", (dialog) => void dialog.accept()); // Remove submission confirms
  await removeBtn.click();
  await expect(page.getByText("Action status")).toBeVisible({ timeout: 20_000 });

  // Appears in the history-inclusive admin list…
  await expect
    .poll(async () => (await adminList(page.request, "?includeHistory=true")).some((s) => s.submissionId === submissionId), {
      timeout: 20_000,
      intervals: [1_000, 2_000, 3_000]
    })
    .toBe(true);

  // …and is gone from the DEFAULT admin queue (core filters archived out).
  const defaultQueue = await adminList(page.request, "");
  expect(defaultQueue.some((s) => s.submissionId === submissionId)).toBe(false);
});

// ---------------------------------------------------------------------------
// 6. Validation FAILURE surfacing (gamma-only): submit a deliberately malformed
//    zip → the 'failed' badge + error detail render on the submission page.
// ---------------------------------------------------------------------------

test("validation failure surfaces a failed badge and error detail @wip", async ({ page }) => {
  test.skip(envName !== "gamma", "gamma-only: creates a failed submission in the review queue");
  const kitName = `${RUN_ID}-bad`;

  await ensureProfileDisplayName(page);
  await cancelStaleE2eSubmissions(page.request);

  // Submit directly (not via submitFixture, which asserts navigation) because a
  // malformed package can EITHER fail asynchronously (navigates, then the badge
  // flips to failed) OR be rejected at submit (form error) — both are valid
  // "failure surfaced" outcomes.
  await page.goto(`${market}/submit`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Submit an Agent Kit" })).toBeVisible();
  await fillSubmitForm(page, kitName, "0.1.0", malformedZip(kitName));
  const outcome = await waitForSubmitOutcome(page);

  if (outcome !== "navigated") {
    // The server refused the malformed package at submit — failure surfaced.
    expect(outcome.length, "submit surfaced a non-empty failure message").toBeGreaterThan(0);
    test.info().annotations.push({ type: "note", description: `submit surfaced failure directly: ${outcome}` });
    return;
  }

  const submissionId = page.url().split("/").filter(Boolean).pop()!;
  const validation = await waitValidationOutcome(page.request, submissionId);
  test.skip(validation === "pending", "validation worker did not resolve on this env");
  expect(validation, "a non-kit zip must fail validation").toBe("failed");

  // Reload the submission page and assert the failed badge + error detail.
  await page.goto(`${market}/submissions/${submissionId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Submission detail" })).toBeVisible();
  await expect(page.locator(".detail-sidebar").getByText(/failed|validation_failed/i).first()).toBeVisible({
    timeout: 20_000
  });
  // Error detail: either the backend errors list ("What needs attention") or the
  // statusDescription copy for a failed validation.
  await expect(
    page
      .getByText("What needs attention")
      .or(page.getByText("Validation found issues that need to be fixed before review."))
      .first()
  ).toBeVisible({ timeout: 20_000 });
});
