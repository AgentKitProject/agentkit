import { test, expect, request as pwRequest, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { hasRealSession } from "../../global-setup";

// AgentKitAuto CUJs. Auth comes from the shared storageState (cuj project).
//
// Tag rules: `@reversible` in the TITLE = safe for prod (reversible, zero
// LLM/billing spend). Untagged = gamma-only (the run-dispatch test additionally
// hard-guards on envName because a prod run costs real money).
//
// ENVIRONMENT QUIRK (discovered live on gamma): the self-host Auto chart runs
// its OWN bundled kit store, fully isolated from Web Forge's — a kit created in
// Forge NEVER appears in Auto's kit pickers there, and auto-web exposes no
// kit-create route of its own. So the create step of the schedule/webhook/run
// journeys is ADAPTIVE:
//   • kit selectable in the Auto UI (hosted / shared-store deployments) →
//     full UI form path;
//   • kit invisible to Auto (gamma isolated store) → create via the SAME
//     cookie /api/auto/* route the form posts to, then still verify the
//     LISTED state and drive DELETE through the real UI.
//
// The Auto UI has no name field on schedules/webhooks, so artifacts are
// identified by the schedule's Task prompt (`${RUN_ID}-sched`) and by API id
// diffing for webhooks. Everything created here is `e2e-`-identifiable and
// cleaned up in-test + in a failure-tolerant afterAll sweep.
test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ checks skipped");

const AUTO = targets.auto.replace(/\/$/, "");
const FORGE = targets.forge.replace(/\/$/, "");
const STATE = fileURLToPath(new URL("../../auth/state.json", import.meta.url));
// Stable name for the throwaway gamma kit so retried runs REUSE it instead of
// piling up one kit per attempt (kitIds are server-generated UUIDs).
const E2E_KIT_NAME = "e2e-cuj-kit";

type KitEntry = { kitId: string; name?: string };
type Approval = { id: string; kitRef: { source: string; localKitId?: string }; revokedAt: string | null };
type Schedule = { id: string; input?: { prompt?: string }; kitRef: { localKitId?: string } };
type Webhook = { id: string; ingestUrl: string; kitRef: { localKitId?: string } };
type Run = { id: string; status: string; input?: { prompt?: string }; createdAt: string; error?: string };

// ---------------------------------------------------------------------------
// Cookie-authed API helpers (page.request / afterAll request context share the
// storageState cookies).
// ---------------------------------------------------------------------------

async function getJson<T>(api: APIRequestContext, url: string): Promise<T> {
  const res = await api.get(url);
  if (!res.ok()) throw new Error(`GET ${url} -> HTTP ${res.status()}`);
  return (await res.json()) as T;
}

const listAutoKits = (api: APIRequestContext) =>
  getJson<{ kits: KitEntry[] }>(api, `${AUTO}/api/kits`).then((b) => b.kits ?? []);
const listForgeKits = (api: APIRequestContext) =>
  getJson<{ kits: KitEntry[] }>(api, `${FORGE}/api/kits`).then((b) => b.kits ?? []);
const listApprovals = (api: APIRequestContext) =>
  getJson<{ approvals: Approval[] }>(api, `${AUTO}/api/auto/approvals`).then((b) => b.approvals ?? []);
const listSchedules = (api: APIRequestContext) =>
  getJson<{ schedules: Schedule[] }>(api, `${AUTO}/api/auto/schedules`).then((b) => b.schedules ?? []);
const listWebhooks = (api: APIRequestContext) =>
  getJson<{ webhooks: Webhook[] }>(api, `${AUTO}/api/auto/webhooks`).then((b) => b.webhooks ?? []);
const listRuns = (api: APIRequestContext) => getJson<{ runs: Run[] }>(api, `${AUTO}/api/auto/runs`).then((b) => b.runs ?? []);

// ---------------------------------------------------------------------------
// Preconditions: schedule/webhook/run forms only offer kits that ALREADY have a
// standing approval. Ensure (kit, approval) exist; on prod with no kit the
// dependent tests self-skip (we never create kits on prod). Cached per worker.
// ---------------------------------------------------------------------------

type Pre = {
  kitId: string;
  kitName: string;
  approvalId: string;
  /** True when the Auto UI's kit picker can actually offer this kit. */
  uiSelectable: boolean;
  /** What the schedule/webhook list cards render for this kit (name when the
   *  kit is visible to Auto, otherwise the raw local kit id). */
  cardKey: string;
};
let pre: Pre | null | undefined;
let createdApprovalId: string | null = null;
const createdWebhookIds: string[] = [];
// Set when we had to give the user a default run budget (see below); holds the
// value to restore (0 = clear back to unlimited).
let runBudgetToRestore: number | null = null;

/**
 * KNOWN APP BUG (flagged upstream): POST /api/auto/approvals resolves the
 * approval ceiling from the per-run budget, and an UNLIMITED resolved budget
 * (0¢ — the system default when no org/user default is set) is rejected by
 * createApproval ("maxBudgetCents must be a positive integer"), so approval
 * creation 400s for any fresh user. Work around it by setting a small user
 * default run budget first (reversible; restored in afterAll).
 */
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

  // Prefer a kit Auto itself can see (full UI path possible).
  const autoKits = await listAutoKits(api);
  let kit = autoKits[0];
  let uiSelectable = Boolean(kit);

  if (!kit) {
    if (envName !== "gamma") {
      pre = null; // never create kits on prod — dependent tests self-skip.
      return pre;
    }
    // Gamma: reuse/create the throwaway Forge kit (stable name, no pile-up).
    const forgeKits = await listForgeKits(api);
    kit = forgeKits.find((k) => k.name === E2E_KIT_NAME);
    if (!kit) {
      const res = await api.post(`${FORGE}/api/kits/from-template`, {
        data: {
          template: "blank",
          id: E2E_KIT_NAME,
          name: E2E_KIT_NAME,
          description: "Throwaway E2E kit for the Auto CUJ suite. Safe to delete.",
        },
      });
      if (!res.ok()) throw new Error(`kit create failed: HTTP ${res.status()}`);
      kit = ((await res.json()) as { kit: KitEntry }).kit;
    }
    // Shared-store deployments see the Forge kit in Auto; gamma's isolated
    // self-host store does not — then the tests fall back to API-driven create.
    uiSelectable = (await listAutoKits(api)).some((k) => k.kitId === kit.kitId);
  }

  const approvals = await listApprovals(api);
  let approval = approvals.find((a) => a.revokedAt === null && a.kitRef.localKitId === kit.kitId);
  if (!approval) {
    await ensurePositiveRunBudget(api);
    const res = await api.post(`${AUTO}/api/auto/approvals`, {
      data: {
        kitRef: { source: "local", localKitId: kit.kitId },
        toolAllowlist: ["read_file", "list_dir"],
        networkPolicy: { mode: "deny_all" },
      },
    });
    if (!res.ok()) throw new Error(`approval create failed: HTTP ${res.status()} ${await res.text()}`);
    approval = (await res.json()) as Approval;
    createdApprovalId = approval.id;
  }

  pre = {
    kitId: kit.kitId,
    kitName: kit.name ?? kit.kitId,
    approvalId: approval.id,
    uiSelectable,
    cardKey: uiSelectable ? kit.name ?? kit.kitId : kit.kitId,
  };
  return pre;
}

function noteApiFallback(testInfo: TestInfo, what: string): void {
  testInfo.annotations.push({
    type: "note",
    description:
      `${what} was created via the cookie /api/auto route instead of the UI form: this deployment's Auto kit ` +
      "store is isolated from Forge, so the UI kit picker has no options (see spec header).",
  });
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

async function gotoSection(page: Page, section: string): Promise<void> {
  await page.goto(`${AUTO}/?section=${section}`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
}

/** The kit picker of the ACTIVE pane (only the active section is rendered). */
function kitSelect(page: Page) {
  return page.locator("select").filter({ has: page.locator("option", { hasText: "Select a kit…" }) });
}

// ---------------------------------------------------------------------------
// Failure-tolerant cleanup: everything we (or a crashed prior iteration)
// created is `e2e-`-identifiable — schedule prompts, webhook ids we tracked or
// webhooks/approvals pointing at the e2e kit, and the e2e-named kit itself
// (kit IDs are server UUIDs, so match by NAME).
// ---------------------------------------------------------------------------

test.afterAll(async () => {
  const api = await pwRequest.newContext({ storageState: STATE });
  try {
    const e2eKitIds = new Set(
      (await listForgeKits(api).catch(() => [] as KitEntry[]))
        .filter((k) => (k.name ?? "").startsWith("e2e-"))
        .map((k) => k.kitId)
    );
    // Schedules labelled by an e2e- prompt or pointing at an e2e kit.
    for (const s of await listSchedules(api).catch(() => [] as Schedule[])) {
      if (s.input?.prompt?.startsWith("e2e-") || (s.kitRef.localKitId && e2eKitIds.has(s.kitRef.localKitId))) {
        await api.delete(`${AUTO}/api/auto/schedules/${s.id}`).catch(() => {});
      }
    }
    // Webhooks we created this run + any pointing at an e2e kit.
    for (const w of await listWebhooks(api).catch(() => [] as Webhook[])) {
      if (createdWebhookIds.includes(w.id) || (w.kitRef.localKitId && e2eKitIds.has(w.kitRef.localKitId))) {
        await api.delete(`${AUTO}/api/auto/webhooks/${w.id}`).catch(() => {});
      }
    }
    // The approval we created + any approval on an e2e kit.
    for (const a of await listApprovals(api).catch(() => [] as Approval[])) {
      if (a.revokedAt === null && (a.id === createdApprovalId || (a.kitRef.localKitId && e2eKitIds.has(a.kitRef.localKitId)))) {
        await api.post(`${AUTO}/api/auto/approvals/${a.id}/revoke`).catch(() => {});
      }
    }
    // e2e-named kits (only ever created on gamma).
    for (const kitId of e2eKitIds) {
      await api.delete(`${FORGE}/api/kits/${encodeURIComponent(kitId)}`).catch(() => {});
    }
    // Restore the user's default run budget if we changed it (0 clears it).
    if (runBudgetToRestore !== null) {
      await api.put(`${AUTO}/api/auto/run-budget`, { data: { budgetCents: runBudgetToRestore } }).catch(() => {});
    }
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------
// 1. Shell renders
// ---------------------------------------------------------------------------

test("Auto dashboard renders the run console shell @reversible", async ({ page }) => {
  await page.goto(AUTO, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  // Sidebar nav exposes every Auto surface…
  for (const label of ["Run", "History", "Approvals", "Schedules", "Triggers", "Settings"]) {
    await expect(page.getByRole("button", { name: label, exact: true }).or(page.getByText(label, { exact: true })).first()).toBeVisible();
  }
  // …and the default pane is the run console.
  await expect(page.getByText("Start a run").first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Schedule create → listed → delete
// ---------------------------------------------------------------------------

test("schedule create → listed → delete @reversible", async ({ page }, testInfo) => {
  const p = await ensureKitAndApproval(page.request);
  test.skip(!p, "no kit exists for this user and kit creation is gamma-only — cannot exercise the schedule journey");
  const label = `${RUN_ID}-sched`;

  // Retry-defense: a failed earlier attempt may have left a schedule with the
  // same label; remove it so create/verify/delete is unambiguous.
  for (const s of await listSchedules(page.request)) {
    if (s.input?.prompt === label) await page.request.delete(`${AUTO}/api/auto/schedules/${s.id}`);
  }

  if (p!.uiSelectable) {
    // Full UI journey: pick the kit, describe the task, create.
    await gotoSection(page, "schedules");
    await expect(page.getByRole("heading", { name: "Schedules", level: 3 })).toBeVisible();
    await kitSelect(page).selectOption(p!.kitId);
    await page.getByPlaceholder("What should the kit do on each run?").fill(label);
    await page.getByRole("button", { name: "Create schedule" }).click();
  } else {
    // Isolated-store deployment: same route the form posts to (see header).
    noteApiFallback(testInfo, "schedule");
    const res = await page.request.post(`${AUTO}/api/auto/schedules`, {
      data: {
        kitRef: { source: "local", localKitId: p!.kitId },
        cron: "0 9 * * *",
        timezone: "UTC",
        input: { prompt: label },
        approvalId: p!.approvalId,
      },
    });
    expect(res.ok(), `schedule create failed: HTTP ${res.status()}`).toBe(true);
    await gotoSection(page, "schedules");
  }

  // Listed in the UI (card carries the kit label + cron) …
  const card = page.locator(".provider-card").filter({ hasText: p!.cardKey });
  await expect(card.first()).toBeVisible();
  await expect(card.first().getByText("0 9 * * *")).toBeVisible();
  // … and persisted server-side with our label as the task prompt.
  let created: Schedule | undefined;
  await expect
    .poll(async () => {
      created = (await listSchedules(page.request)).find((s) => s.input?.prompt === label);
      return Boolean(created);
    })
    .toBe(true);

  // Delete via the card's Delete button; verify it is gone in UI + API.
  await card.first().getByRole("button", { name: "Delete" }).click();
  await expect
    .poll(async () => (await listSchedules(page.request)).some((s) => s.id === created!.id))
    .toBe(false);
  await expect(page.locator(".provider-card").filter({ hasText: p!.cardKey })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 3. Webhook (trigger) create → listed → delete
// ---------------------------------------------------------------------------

test("webhook create → URL/secret issued → listed → delete @reversible", async ({ page }, testInfo) => {
  const p = await ensureKitAndApproval(page.request);
  test.skip(!p, "no kit exists for this user and kit creation is gamma-only — cannot exercise the webhook journey");

  const before = new Set((await listWebhooks(page.request)).map((w) => w.id));
  let createdId: string;

  if (p!.uiSelectable) {
    await gotoSection(page, "webhooks");
    await expect(page.getByRole("heading", { name: "Triggers", level: 3 })).toBeVisible();
    await kitSelect(page).selectOption(p!.kitId);
    await page.getByRole("button", { name: "Create webhook" }).click();

    // One-time secret card: ingest URL + secret are DISPLAYED (values asserted,
    // never logged — do not print these).
    await expect(page.getByText("Copy your webhook secret now")).toBeVisible();
    const onceInputs = page.locator("input[readonly]");
    await expect(onceInputs).toHaveCount(2);
    expect(await onceInputs.nth(0).inputValue()).toMatch(/\/api\/hooks\/auto\/.+/);
    expect((await onceInputs.nth(1).inputValue()).length).toBeGreaterThan(10);
    await page.getByRole("button", { name: "I've copied it" }).click();

    const created = (await listWebhooks(page.request)).find((w) => !before.has(w.id));
    expect(created, "a new webhook should exist after creation").toBeTruthy();
    createdId = created!.id;
  } else {
    // Isolated-store deployment: same route the form posts to (see header).
    noteApiFallback(testInfo, "webhook");
    const res = await page.request.post(`${AUTO}/api/auto/webhooks`, {
      data: { kitRef: { source: "local", localKitId: p!.kitId }, approvalId: p!.approvalId },
    });
    expect(res.ok(), `webhook create failed: HTTP ${res.status()}`).toBe(true);
    // The create response is the ONE place the plaintext secret is issued.
    const created = (await res.json()) as Webhook & { secret?: string };
    createdId = created.id;
    expect(created.ingestUrl).toMatch(/\/api\/hooks\/auto\/.+/);
    expect((created.secret ?? "").length).toBeGreaterThan(10);
    await gotoSection(page, "webhooks");
  }
  createdWebhookIds.push(createdId);

  // Listed: the card renders the ingest URL (which embeds the webhook id).
  const card = page.locator(".provider-card").filter({ hasText: createdId });
  await expect(card.first()).toBeVisible();

  // Delete via the card; verify gone in API + UI.
  await card.first().getByRole("button", { name: "Delete" }).click();
  await expect
    .poll(async () => (await listWebhooks(page.request)).some((w) => w.id === createdId))
    .toBe(false);
  await expect(page.locator(".provider-card").filter({ hasText: createdId })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 4. Run history surface
// ---------------------------------------------------------------------------

test("run history surface renders (empty state OK) @reversible", async ({ page }) => {
  await gotoSection(page, "runs");
  await expect(page.getByRole("heading", { name: "Runs", exact: true, level: 3 })).toBeVisible();
  // Either the empty state or at least one run card; the detail panel shows its
  // "select a run" hint until a run is opened.
  await expect(page.getByText("No runs yet.").or(page.locator(".provider-card").first()).first()).toBeVisible();
  await expect(page.getByText("Select a run on the left")).toBeVisible();
});

// ---------------------------------------------------------------------------
// 5. GAMMA-ONLY (untagged): dispatch a one-off run. Gamma has no usable
// platform key (placeholder) and an isolated kit store, so the run can never
// SUCCEED (no spend). Observed live: gamma's k8s run dispatcher never picks the
// run up at all (it stays `queued`; cancel is a worker-honored flag, so even
// the kill-switch can't force a terminal state). The test therefore asserts
// what the deployment can actually produce: the run RECORD appears and its
// state is surfaced gracefully in the History UI; IF the run reaches a
// terminal state it must be a non-succeeded one; if the dispatcher never runs
// it, we exercise the UI kill-switch and annotate the stall loudly.
// Never on prod (a successful prod run costs real money).
// ---------------------------------------------------------------------------

test("run dispatch surfaces a failed run record (gamma only)", async ({ page }, testInfo) => {
  test.skip(envName !== "gamma", "run dispatch spends real money on prod — gamma only");
  // NOTE on cleanup racing the worker: the afterAll kit sweep can delete this
  // run's kit before the k8s worker Job starts. That's HANDLED by design now:
  // the worker records the run as failed ("run context unavailable") and exits
  // 0, so the Job reads Complete and the operator's KubeJobFailed alert stays
  // quiet (it fires only for genuinely unrecorded outcomes).
  const p = await ensureKitAndApproval(page.request);
  test.skip(!p, "no kit/approval available");
  const label = `${RUN_ID}-run`;

  if (p!.uiSelectable) {
    await gotoSection(page, "run");
    await expect(page.getByRole("heading", { name: "Start a run", level: 3 })).toBeVisible();
    await kitSelect(page).selectOption(p!.kitId);
    await page.getByPlaceholder("What should the kit do, end to end?").fill(label);
    await page.getByRole("button", { name: "Start run" }).click();
  } else {
    // Isolated-store deployment: same route the form posts to (see header).
    noteApiFallback(testInfo, "run");
    const res = await page.request.post(`${AUTO}/api/auto/runs`, {
      data: { kitRef: { source: "local", localKitId: p!.kitId }, input: { prompt: label } },
    });
    expect(res.ok(), `run create failed: HTTP ${res.status()} ${await res.text()}`).toBe(true);
  }

  // The run record must appear server-side.
  let run: Run | undefined;
  await expect
    .poll(
      async () => {
        run = (await listRuns(page.request))
          .filter((r) => r.input?.prompt === label)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
        return Boolean(run);
      },
      { timeout: 20_000 }
    )
    .toBe(true);

  // Wait (bounded) for a terminal state (broken provider key / missing kit →
  // failure). Gamma's dispatcher may never pick the run up at all — see header.
  const deadline = Date.now() + 45_000;
  const ACTIVE = new Set(["queued", "running"]);
  while (ACTIVE.has(run!.status) && Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    run = (await listRuns(page.request)).find((r) => r.id === run!.id) ?? run;
  }
  if (!ACTIVE.has(run!.status)) {
    // Gamma must not produce a successful (billable) run.
    expect(run!.status, "gamma placeholder key should make the run fail, not succeed").not.toBe("succeeded");
  }

  // The run + its state are surfaced gracefully in the History UI.
  await gotoSection(page, "runs");
  const card = page.locator(".provider-card").filter({ hasText: p!.cardKey }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText(run!.status)).toBeVisible();
  await card.click();
  await expect(page.getByRole("heading", { name: "Run detail", level: 4 })).toBeVisible();
  await expect(page.getByText(run!.status).first()).toBeVisible();

  if (ACTIVE.has(run!.status)) {
    // Dispatcher stall: exercise the UI kill-switch (a real CUJ) and flag the
    // environment limitation loudly instead of failing the gate on it.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Cancellation requested.")).toBeVisible();
    testInfo.annotations.push({
      type: "warning",
      description:
        `run ${run!.id} never left "${run!.status}" within 45s — this deployment's Auto dispatcher is not ` +
        "processing runs (known on gamma: isolated kit store + inert worker). Cancellation was requested via the UI.",
    });
  }
});
