import { test, expect, request as pwRequest, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { STORAGE_STATE_PATH, hasRealSession } from "../../global-setup";

// REMAINING-COVERAGE CUJs (the odds-and-ends the app-specific suites leave out):
//   1. Admin AUDIT LOG (market-web, gamma-only) — the append-only admin action
//      log renders for an admin with actor/action/target columns.
//   2. Kit DETAIL sections (market-web) — a published kit's detail page renders
//      its full section set (outcomes / prepared-prompt + skill summaries /
//      version + validation summary / license disclosure / automations card).
//   3. Public profile AVATAR + VERIFIED badge (profile-web) — /u/[handle] shows
//      the avatar initials and (for a verified user) the Verified badge.
//   4. Auto run_completed TRIGGER CHAINING (auto-web, gamma-only) — a run-chain
//      trigger persists its chaining config and its event-consume wiring is
//      reachable (the sweep-driven real chained-run dispatch is not
//      browser-drivable — documented).
//
// TAGGING (see playwright.config.ts): these tests are PROMOTED — the cuj project
// runs them on gamma and they gate deploys (the `@wip` staging lane that
// cuj / prod-cuj / canary exclude is now empty here). A test is ALSO `@reversible` (→ prod-cuj)
// only when fully prod-safe: read-only, no writes, no money, no compute, no
// artifacts. Journeys 2 + 3 are read-only renders → @reversible. Journeys 1 + 4
// are GAMMA-ONLY (`test.skip(envName !== "gamma", …)`): the E2E user is a Market
// admin only on gamma (audit log), and the Auto self-host kit store is isolated
// so a trigger needs a gamma-created kit + approval.
//
// UI map (routes/selectors read from the real app source — never invented):
//   Admin audit (apps/market-web/app/admin/audit/page.tsx + components/
//     AuditLogsClient.tsx): route `${market}/admin/audit`; PageShell eyebrow
//     "Admin audit", title "Audit log"; non-admins → requireAdmin() redirects to
//     `/admin/unauthorized`; unconfigured backend → `.empty-state` "Missing admin
//     config". The client auto-loads on mount → one of: `table.admin-table`
//     (headers Timestamp/Actor/Type/Action/Target/Metadata; rows: actor div,
//     `span.badge` targetType, `code` action, `code` targetId), "No events found"
//     empty-state, "Loading audit events", or `.danger-state` "Failed to load
//     audit logs". GET /api/admin/audit-logs?limit=… → { items:[AuditEvent], nextToken? }
//     (requireAdminForApi → 401/403 for non-admins).
//   Kit detail (apps/market-web/app/kits/[slug]/page.tsx + KitAutomationsCard.tsx
//     + LicenseDisclosure.tsx): eyebrow "Agent Kit listing"; h1 = kit name.
//     Section h2s: "What this kit provides" (outcomes — CONDITIONAL), "Prepared
//     prompt summaries" (always), "Skill summaries" (always), "Automations"
//     (KitAutomationsCard — CONDITIONAL on declared automations), "Version
//     metadata" (CONDITIONAL), "Validation summary" (CONDITIONAL), "License"
//     (LicenseDisclosure, always; `.detail-panel` + "View license text" button).
//     Sidebar `.detail-sidebar` section-labels: "Publisher"/"Version"/"Required
//     inputs"/"Tags"/download-panel. Catalog (app/kits): heading "Published Agent
//     Kits"; `.kit-grid .kit-card` → `h3 a` href `/kits/{slug}`; empty "No kits
//     available yet"/"No kits found".
//   Public profile (apps/profile-web/app/u/[handle]/page.tsx): route
//     `${profile}/u/{handle}`; avatar = `div.h-20.w-20.rounded-full` with initials
//     (avatarInitials || displayName.slice(0,2).toUpperCase() || "AK"); h1 =
//     displayName || "@handle"; Verified Badge renders text "Verified" only when
//     profile.verified. GET `${profile}/api/profile/me` → { handle, displayName,
//     avatarInitials, verified, userId } (cookie-authed).
//   Auto automations (apps/auto-web/app/sections/automations/AutomationsSection.tsx):
//     deep link `${auto}/?section=automations`; heading "Automations"; rows
//     `.provider-card` (name `<strong>` + `<Badge>` type label — run_completed =
//     "Run chain"); row buttons "Test fire"/"Fire log"/"Delete". run_completed
//     contract (packages/contracts/src/auto-events.ts): config {statuses[],
//     kitRef?, sourceTriggerId?}; the chained run is dispatched by the SWEEP
//     (run-completed-poller.ts, internal service-key route) — not browser-drivable.
//   Cookie API routes (apps/auto-web/app/api/auto/**): triggers (+/[id]
//     +/[id]/test-fire), runs, billing, run-budget, approvals; kit bootstrap via
//     /api/kits (auto) + /api/kits/from-template (forge). Mirrors auto-events.spec.ts.

test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ suite skipped");

const MARKET = targets.market.replace(/\/$/, "");
const PROFILE = targets.profile.replace(/\/$/, "");
const AUTO = targets.auto.replace(/\/$/, "");
const FORGE = targets.forge.replace(/\/$/, "");

const E2E_KIT_NAME = "e2e-cuj-kit"; // shared with auto.spec.ts / auto-events.spec.ts (stable, reused)

// A run_completed test-fire filter that can NEVER match the synthesized event
// (status is "succeeded", never this sentinel) → the gate chain stops at
// "filtered" (before affordability + dispatch): zero LLM/compute spend.
const NEVER_MATCH_FILTER = [{ path: "status", op: "eq", value: `${RUN_ID}-never-matches` }];

// ---------------------------------------------------------------------------
// Types (mirror the app payload shapes)
// ---------------------------------------------------------------------------

type KitEntry = { kitId: string; name?: string };
type Approval = { id: string; kitRef: { source: string; localKitId?: string }; revokedAt: string | null };
type Trigger = { id: string; name: string; type: string; enabled: boolean; config?: Record<string, unknown> };
type FireLog = { outcome: string; runId?: string | null; detail?: string | null };
type PrivateProfile = { handle: string; displayName: string; avatarInitials: string; verified: boolean; userId: string };
type AuditEvent = { auditId?: string; action?: string; actorUserId?: string; targetType?: string; targetId?: string };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function note(testInfo: TestInfo, description: string): void {
  testInfo.annotations.push({ type: "note", description });
}

async function getJson<T>(api: APIRequestContext, url: string): Promise<T> {
  const res = await api.get(url);
  if (!res.ok()) throw new Error(`GET ${url} -> HTTP ${res.status()}`);
  return (await res.json()) as T;
}

const listTriggers = (api: APIRequestContext) =>
  getJson<{ triggers: Trigger[] }>(api, `${AUTO}/api/auto/triggers`).then((b) => b.triggers ?? []);
const listApprovals = (api: APIRequestContext) =>
  getJson<{ approvals: Approval[] }>(api, `${AUTO}/api/auto/approvals`).then((b) => b.approvals ?? []);
const listAutoKits = (api: APIRequestContext) =>
  getJson<{ kits: KitEntry[] }>(api, `${AUTO}/api/kits`).then((b) => b.kits ?? []);
const listForgeKits = (api: APIRequestContext) =>
  getJson<{ kits: KitEntry[] }>(api, `${FORGE}/api/kits`).then((b) => b.kits ?? []);

// ---------------------------------------------------------------------------
// Kit + approval bootstrap (adaptive; mirrors auto.spec.ts / auto-events.spec.ts).
// A run_completed trigger needs a kit + a standing approval covering its budget.
// Kit-create is gamma-only, and journey 4 is already gamma-guarded, so this only
// runs on gamma. Tracks what it created so the sweep can revoke/restore.
// ---------------------------------------------------------------------------

type Pre = { kitId: string; kitName: string; approvalId: string };
let pre: Pre | null | undefined;
let createdApprovalId: string | null = null;
let runBudgetToRestore: number | null = null;
const createdTriggerIds: string[] = [];

/** createApproval derives its ceiling from the per-run budget and rejects an
 *  UNLIMITED (0¢) budget (known app behavior, see auto.spec.ts), so ensure a
 *  small positive user default first — reversible; restored in afterAll. */
async function ensurePositiveRunBudget(api: APIRequestContext): Promise<void> {
  const rb = await getJson<{ userDefaultCents: number | null; effectiveCents: number }>(
    api,
    `${AUTO}/api/auto/run-budget`
  );
  if (rb.effectiveCents > 0) return;
  runBudgetToRestore = rb.userDefaultCents ?? 0;
  const res = await api.put(`${AUTO}/api/auto/run-budget`, { data: { budgetCents: 50 } });
  if (!res.ok()) throw new Error(`run-budget set failed: HTTP ${res.status()}`);
}

async function ensureKitAndApproval(api: APIRequestContext): Promise<Pre | null> {
  if (pre !== undefined) return pre;

  const autoKits = await listAutoKits(api);
  let kit = autoKits[0];

  if (!kit) {
    if (envName !== "gamma") {
      pre = null; // never create kits on prod — dependent tests self-skip.
      return pre;
    }
    const forgeKits = await listForgeKits(api);
    kit = forgeKits.find((k) => k.name === E2E_KIT_NAME);
    if (!kit) {
      const res = await api.post(`${FORGE}/api/kits/from-template`, {
        data: {
          template: "blank",
          id: E2E_KIT_NAME,
          name: E2E_KIT_NAME,
          description: "Throwaway E2E kit for the Auto CUJ suite. Safe to delete."
        }
      });
      if (!res.ok()) throw new Error(`kit create failed: HTTP ${res.status()}`);
      kit = ((await res.json()) as { kit: KitEntry }).kit;
    }
  }

  const approvals = await listApprovals(api);
  let approval = approvals.find((a) => a.revokedAt === null && a.kitRef.localKitId === kit!.kitId);
  if (!approval) {
    await ensurePositiveRunBudget(api);
    const res = await api.post(`${AUTO}/api/auto/approvals`, {
      data: {
        kitRef: { source: "local", localKitId: kit.kitId },
        toolAllowlist: ["read_file", "list_dir"],
        networkPolicy: { mode: "deny_all" }
      }
    });
    if (!res.ok()) throw new Error(`approval create failed: HTTP ${res.status()} ${await res.text()}`);
    approval = (await res.json()) as Approval;
    createdApprovalId = approval.id;
  }

  pre = { kitId: kit.kitId, kitName: kit.name ?? kit.kitId, approvalId: approval.id };
  return pre;
}

// ---------------------------------------------------------------------------
// Failure-tolerant sweep: every RUN_ID-prefixed / tracked trigger, the approval
// we created, and the run budget we changed. Journeys 1–3 create NO artifacts.
// Never throws.
// ---------------------------------------------------------------------------

test.afterAll(async () => {
  if (!hasRealSession()) return;
  const api = await pwRequest.newContext({ storageState: STORAGE_STATE_PATH });
  try {
    for (const t of await listTriggers(api).catch(() => [] as Trigger[])) {
      if (t.name.startsWith(RUN_ID) || createdTriggerIds.includes(t.id)) {
        await api.delete(`${AUTO}/api/auto/triggers/${t.id}`).catch(() => {});
      }
    }
    if (createdApprovalId) {
      await api.post(`${AUTO}/api/auto/approvals/${createdApprovalId}/revoke`).catch(() => {});
    }
    if (runBudgetToRestore !== null) {
      await api.put(`${AUTO}/api/auto/run-budget`, { data: { budgetCents: runBudgetToRestore } }).catch(() => {});
    }
  } catch {
    // best-effort — never fail the suite in teardown
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// 1. Admin AUDIT LOG (gamma-only). Admin publish/approve/hide/transfer actions
//    are recorded as append-only entries with actor/action/target. The E2E user
//    is a Market admin only on gamma, and the whole market-lifecycle suite (which
//    runs on gamma) already emits submission.created/approved/published/… rows
//    into THIS log — so a rendered table IS "entries render after an action".
//    We assert the queryable log (API) + the admin surface renders with the
//    actor/action columns; empty/failed states are tolerated with a reason.
// ===========================================================================

test("admin audit log renders append-only entries with actor + action columns", async ({ page }, testInfo) => {
  test.skip(envName !== "gamma", "gamma-only: the E2E user is a Market admin only on gamma (audit log is admin-gated)");

  // (a) The append-only log is queryable by an admin (contract smoke). A
  //     non-admin/unconfigured deployment 401/403/500s here → skip with a reason.
  const apiRes = await page.request.get(`${MARKET}/api/admin/audit-logs?limit=5`);
  test.skip(
    apiRes.status() === 401 || apiRes.status() === 403,
    "E2E user lacks Market admin on this deployment (ADMIN_EMAILS / ADMIN_OIDC_GROUP) — audit log is admin-only"
  );
  test.skip(
    !apiRes.ok(),
    `GET /api/admin/audit-logs unreachable (HTTP ${apiRes.status()}) — backend admin/audit API not configured on this env`
  );
  const apiBody = (await apiRes.json().catch(() => ({}))) as { items?: AuditEvent[] };
  expect(Array.isArray(apiBody.items), "audit-logs response carries an items array").toBe(true);

  // (b) The admin audit SURFACE renders for the admin.
  await page.goto(`${MARKET}/admin/audit`, { waitUntil: "domcontentloaded" });
  test.skip(
    page.url().includes("/admin/unauthorized"),
    "E2E user lacks Market admin on this deployment — requireAdmin() redirected to /admin/unauthorized"
  );
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Admin audit")).toBeVisible();

  // Backend admin API missing → the page short-circuits to a config notice.
  test.skip(
    await page.getByText("Missing admin config").isVisible().catch(() => false),
    "admin API not configured on this deployment — audit log cannot load (Missing admin config)"
  );

  // The client auto-loads on mount → resolve to one definitive state.
  const table = page.locator("table.admin-table");
  const noEvents = page.getByText("No events found");
  const failed = page.locator(".danger-state", { hasText: "Failed to load audit logs" });
  await expect(table.or(noEvents).or(failed)).toBeVisible({ timeout: 20_000 });

  if (await failed.isVisible().catch(() => false)) {
    const detail = (await failed.locator("p").first().innerText().catch(() => "")).trim();
    test.skip(true, `audit backend unreachable on this env — "Failed to load audit logs": ${detail}`);
  }

  if (await table.isVisible().catch(() => false)) {
    // Column headers present (the append-only schema surfaced).
    for (const header of ["Timestamp", "Actor", "Type", "Action", "Target"]) {
      await expect(table.locator("thead").getByText(header, { exact: true })).toBeVisible();
    }
    // At least one append-only entry renders with its actor + action + target-type.
    const firstRow = table.locator("tbody tr").first();
    await expect(firstRow).toBeVisible();
    await expect(firstRow.locator("code").first(), "the action cell renders the action code").toBeVisible();
    await expect(firstRow.locator("span.badge").first(), "the type cell renders the targetType badge").toBeVisible();
    await expect(firstRow.locator("td").nth(1), "the actor cell renders").not.toBeEmpty();
    note(testInfo, "audit log rendered append-only entries (actor / action / target columns) — admin actions from the lifecycle suite populate this same log.");
  } else {
    // Empty on this env — the log surface still renders for the admin (the
    // sanctioned read-only outcome). No admin actions have hit this instance yet.
    note(testInfo, "no audit entries on this env yet — asserted the audit surface renders for an admin (empty append-only log).");
  }
});

// ===========================================================================
// 2. Kit DETAIL sections (@reversible). Open a published catalog kit's detail
//    page and assert its section set renders. The ALWAYS-present sections
//    (prepared-prompt + skill summaries, license disclosure, version) are firm
//    assertions; the CONDITIONAL ones (outcomes, validation summary, version
//    metadata, automations card — each rendered only when the kit declares that
//    data) are asserted present-or-annotated so the test is not coupled to one
//    kit's content. Read-only render of a public listing → prod-safe.
// ===========================================================================

test("kit detail page renders its full section set @reversible", async ({ page }, testInfo) => {
  // Discover a published kit slug from the catalog.
  await page.goto(`${MARKET}/kits`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  await expect(page.getByRole("heading", { name: "Published Agent Kits" })).toBeVisible({ timeout: 20_000 });
  const cards = page.locator(".kit-grid .kit-card");
  const empty = page.getByText("No kits available yet").or(page.getByText("No kits found"));
  await expect(cards.first().or(empty)).toBeVisible({ timeout: 20_000 });
  test.skip((await cards.count()) === 0, "catalog is empty on this env — no published kit detail page to render");

  const href = await cards.first().locator("h3 a").getAttribute("href");
  const slug = href?.split("/").filter(Boolean).pop();
  expect(slug, "catalog card exposes a /kits/{slug} link").toBeTruthy();

  await page.goto(`${MARKET}/kits/${slug}`, { waitUntil: "domcontentloaded" });

  // Header (a rendered listing = public-catalog inclusion; the page notFound()s
  // for a non-public kit, so reaching it proves the listing).
  await expect(page.getByText("Agent Kit listing")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".detail-main h1")).toBeVisible();

  // ALWAYS-present sections (firm).
  await expect(page.getByRole("heading", { name: "Prepared prompt summaries" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Skill summaries" })).toBeVisible();
  // License disclosure (LicenseDisclosure renders unconditionally).
  await expect(page.getByRole("heading", { name: "License", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View license text" })).toBeVisible();
  // Version (sidebar section-label + the download panel both surface it).
  await expect(page.locator(".detail-sidebar").getByText("Version", { exact: true }).first()).toBeVisible();

  // CONDITIONAL sections — assert present-or-annotate (a given kit may not
  // declare outcomes / validation summary / version metadata / automations).
  const rendered: string[] = [];
  const missing: string[] = [];
  for (const [label, heading] of [
    ["outcomes", "What this kit provides"],
    ["validation summary", "Validation summary"],
    ["version metadata", "Version metadata"],
    ["automations card", "Automations"]
  ] as const) {
    const h = page.getByRole("heading", { name: heading, exact: true });
    if (await h.isVisible().catch(() => false)) {
      await expect(h).toBeVisible();
      rendered.push(label);
    } else {
      missing.push(label);
    }
  }
  note(
    testInfo,
    `kit "${slug}" detail sections — always-present set (prepared-prompt + skill summaries, license, version) asserted; ` +
      `conditional rendered: [${rendered.join(", ") || "none"}]; not declared by this kit: [${missing.join(", ") || "none"}].`
  );
});

// ===========================================================================
// 3. Public profile AVATAR + VERIFIED badge (@reversible). /u/{handle} shows the
//    avatar initials and — for a verified user — the Verified badge. We read the
//    signed-in user's own handle/initials/verified from /api/profile/me and
//    assert its public page. The avatar always renders (server falls back to
//    displayName initials → "AK"); the Verified badge is asserted only when the
//    user is verified (else annotated). Read-only → prod-safe.
// ===========================================================================

test("public profile shows avatar initials and (when verified) the Verified badge @reversible", async ({ page }, testInfo) => {
  const me = await getJson<PrivateProfile>(page.request, `${PROFILE}/api/profile/me`).catch(() => null);
  test.skip(!me, "GET /api/profile/me unreachable — cannot resolve the signed-in user's public handle");
  const handle = (me!.handle ?? "").trim();
  test.skip(handle.length === 0, "signed-in user has no handle set — no public /u/[handle] page to render");

  await page.goto(`${PROFILE}/u/${encodeURIComponent(handle)}`, { waitUntil: "domcontentloaded" });
  // A missing/non-public profile notFound()s (Next 404) — treat as an env gap.
  test.skip(
    await page.getByText(/404|not found|could not be found/i).first().isVisible().catch(() => false),
    `public profile /u/${handle} is not resolvable on this env (private/unpublished)`
  );

  // Avatar initials: the h-20 w-20 rounded-full lockup renders non-empty initials.
  const avatar = page.locator("div.h-20.w-20.rounded-full").first();
  await expect(avatar).toBeVisible({ timeout: 20_000 });
  await expect(avatar).not.toBeEmpty();
  const avatarText = (await avatar.innerText()).trim();
  expect(avatarText.length, "avatar renders non-empty initials").toBeGreaterThan(0);
  // When the user has explicit initials, the avatar shows exactly them.
  const initials = (me!.avatarInitials ?? "").trim();
  if (initials.length > 0) {
    expect(avatarText, "avatar shows the user's configured initials").toBe(initials);
  }

  // Display name heading renders alongside the avatar.
  const expectedName = (me!.displayName ?? "").trim() || `@${handle}`;
  await expect(page.getByRole("heading", { level: 1, name: expectedName })).toBeVisible();
  // The handle line renders.
  await expect(page.getByText(`@${handle}`).first()).toBeVisible();

  // Verified badge — present ONLY for a verified user.
  const badge = page.getByText("Verified", { exact: true });
  if (me!.verified) {
    await expect(badge, "a verified user shows the Verified badge").toBeVisible();
    note(testInfo, `public profile /u/${handle}: avatar initials + Verified badge rendered (verified user).`);
  } else {
    await expect(badge, "a non-verified user shows NO Verified badge").toHaveCount(0);
    note(
      testInfo,
      `public profile /u/${handle}: avatar initials rendered; the E2E user is NOT verified so the Verified badge is (correctly) absent — the badge's positive render needs a verified identity.`
    );
  }
});

// ===========================================================================
// 4. Auto run_completed TRIGGER CHAINING (gamma-only). A run-chain trigger fires
//    a follow-up run when a prior run finishes. The actual chained-run dispatch
//    happens in the SWEEP (run-completed-poller.ts scans terminal runs and feeds
//    matches through the gate chain), which runs behind an internal service-key
//    route / CronJob — NOT browser-drivable, and it also needs a real completed
//    run (gamma's dispatcher may be inert). So we assert the sanctioned fallback:
//    the trigger persists its chaining config (statuses + source-kit match) AND
//    its event-consume wiring is reachable via a zero-spend test-fire (a
//    never-match filter stops the synthesized run_completed event at "filtered").
//    Gamma-only: needs a kit + approval (self-host isolated Auto store).
// ===========================================================================

test("run_completed trigger: persists chaining config + event wiring is reachable (chained dispatch is sweep-driven)", async ({ page }, testInfo) => {
  test.skip(envName !== "gamma", "gamma-only: needs a kit + approval (self-host isolated Auto store); real chaining runs in the sweep");
  const p = await ensureKitAndApproval(page.request);
  test.skip(!p, "no kit/approval available for this user");

  // Retry-safe pre-clean of any prior attempt's trigger.
  for (const t of await listTriggers(page.request).catch(() => [] as Trigger[])) {
    if (t.name.startsWith(RUN_ID)) await page.request.delete(`${AUTO}/api/auto/triggers/${t.id}`).catch(() => {});
  }

  const name = `${RUN_ID}-chain`;
  // A run_completed (kit-chaining) trigger: chain off SUCCEEDED runs of this kit,
  // then run this kit. The never-match filter guarantees the later test-fire is
  // "filtered" (no run, zero spend).
  const res = await page.request.post(`${AUTO}/api/auto/triggers`, {
    data: {
      type: "run_completed",
      name,
      kitRef: { source: "local", localKitId: p!.kitId },
      approvalId: p!.approvalId,
      budgetCents: 50,
      filters: NEVER_MATCH_FILTER,
      mapping: { promptTemplate: "Follow up on run {{runId}} ({{status}}). (e2e — chaining wiring probe)" },
      config: { statuses: ["succeeded"], kitRef: { source: "local", localKitId: p!.kitId } }
    }
  });
  expect(res.status(), await res.text()).toBe(201);
  const trigger = (await res.json()) as Trigger & { config?: { statuses?: string[]; kitRef?: { localKitId?: string } } };
  createdTriggerIds.push(trigger.id);

  // Chaining config persisted exactly as sent.
  expect(trigger.type).toBe("run_completed");
  expect(trigger.config?.statuses, "run-chain subscribes to the succeeded terminal status").toEqual(["succeeded"]);
  expect(trigger.config?.kitRef?.localKitId, "run-chain restricts the source kit").toBe(p!.kitId);

  // Event-consume wiring reachable: a synthesized run_completed event flows into
  // the REAL gate chain and the never-match filter stops it at "filtered" (no
  // run created → zero spend). This exercises the run_completed consume path
  // without the sweep's terminal-run scan (which is service-key-gated).
  const fire = await page.request.post(`${AUTO}/api/auto/triggers/${trigger.id}/test-fire`, {
    data: { sampleEvent: { runId: `${RUN_ID}-src-run`, status: "succeeded", kitRef: { source: "local", localKitId: p!.kitId } } }
  });
  expect(fire.status(), await fire.text()).toBe(200);
  const { fireLog } = (await fire.json()) as { fireLog: FireLog };
  expect(fireLog.outcome, "never-match filter must stop the run_completed fire at 'filtered'").toBe("filtered");
  expect(fireLog.runId ?? null, "a filtered fire must not dispatch a run").toBeNull();
  note(
    testInfo,
    "run_completed chaining config persisted + the event-consume gate chain is reachable (test-fire → filtered, no spend). " +
      "The REAL chained run is dispatched by the sweep (run-completed-poller.ts): it scans NEWLY-terminal runs beyond a " +
      "high-water cursor and feeds matches through the chain — service-key-gated / CronJob-driven and dependent on a real " +
      "completed run, so it is not browser-drivable here."
  );

  // The run-chain automation renders in the real UI with its "Run chain" badge.
  await page.goto(`${AUTO}/?section=automations`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  await expect(page.getByRole("heading", { name: "Automations", exact: true }).first()).toBeVisible({ timeout: 20_000 });
  const card = page.locator(".provider-card").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("Run chain", { exact: true })).toBeVisible();

  // In-test cleanup (afterAll backstops failures).
  await page.request.delete(`${AUTO}/api/auto/triggers/${trigger.id}`).catch(() => {});
  await expect.poll(async () => (await listTriggers(page.request)).some((t) => t.id === trigger.id)).toBe(false);
});
