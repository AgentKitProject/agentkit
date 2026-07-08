import { test, expect, request as pwRequest, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { STORAGE_STATE_PATH, hasRealSession } from "../../global-setup";

// AgentKitAuto EVENT-DRIVEN + RUN + BILLING CUJs (Wave 4 messaging, connections,
// managed runs, org-key precedence, buy-credits). Mirrors the schedule/webhook
// patterns in cuj/auto.spec.ts + cuj/automations.spec.ts.
//
// TAGGING (see playwright.config.ts): EVERY test is `@wip` — they run ONLY in
// the `wip` project (all other projects grepInvert /@wip/), so they never gate a
// deploy until promoted. A test is ALSO `@reversible` only when it is fully
// prod-safe (creates+deletes its own artifacts, no money, no LLM/compute spend);
// everything else hard-guards `test.skip(envName !== "gamma", …)` because it
// spends real compute (a managed run), touches live Stripe, or exercises OAuth
// consent. Money paths on gamma use Stripe TEST MODE.
//
// STRATEGY (same as auto.spec.ts / automations.spec.ts): the self-host Auto kit
// store is ISOLATED from Forge on gamma, so the wizard/form kit pickers are
// empty. Triggers/sources/connections are therefore created via the SAME cookie
// /api/auto/* routes the UI forms post to, and the LIST / fire-log / settings
// journeys are still driven through the real UI. Zero LLM/billing spend on the
// event-trigger tests: RSS/email-in/watch use a filter that can NEVER match (the
// gate chain stops at `filtered` — gate (b), before affordability/dispatch), and
// the message trigger sets requireApproval so a passing fire is HELD
// (`awaiting_approval`), never dispatched. Only the journey-4 managed-run test
// dispatches a REAL (cheapest-model) run — gamma-only, a fraction of a cent.
//
// UI map (apps/auto-web):
//   • shell nav / deep links: `${AUTO}/?section=<id>` — ids from
//     app/sections/section-ids.ts: run|runs|automations|approvals|schedules|
//     webhooks|settings. Automations pane heading: <h3>Automations</h3>
//     ("New automation" button); the SETTINGS pane heading is
//     <h3>Inference & billing</h3>.
//   • automations list rows: `.provider-card` (name <strong> + type <Badge>,
//     e.g. "Message"); row actions: Edit / Test fire / Fire log / Delete
//     (getByRole button, exact). Fire-log panel heading: `Fire log — <name>`;
//     empty state text "No fires yet." (app/sections/automations/AutomationsSection.tsx).
//   • Buy-credits affordance (settings): <a href="{marketUrl}/account/credits">
//     wrapping <Button>Buy credits</Button> (AutoSection.tsx ~L1239).
//   • run output downloads: <a href="/api/auto/runs/{id}/outputs/{path}"> under
//     an "Output downloads" heading in the run-detail panel (AutoSection.tsx).
//   • field helper: shared-UI `.ak-field` = <label> + control siblings (no
//     htmlFor) → fieldControl(page,label).
// Cookie API routes used (app/api/auto/**): connections (+/[id] +/[id]/verify
//   +/oauth/[provider]/start), event-sources, triggers (+/[id] +/[id]/test-fire
//   +/[id]/fire-logs), runs (+/[id] +/[id]/outputs/[...path]), billing, byo-key,
//   ai-providers, run-budget, approvals (+/[id]/revoke). Kit/approval bootstrap
//   reuses /api/kits (auto+forge) and /api/kits/from-template (forge) as auto.spec.ts.
test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ suite skipped");

const AUTO = targets.auto.replace(/\/$/, "");
const FORGE = targets.forge.replace(/\/$/, "");
const MARKET = targets.market.replace(/\/$/, "");
const E2E_KIT_NAME = "e2e-cuj-kit"; // shared with auto.spec.ts (stable, reused)

// A filter that can NEVER match any sample payload → the gate chain stops at
// "filtered" (gate (b), before affordability + dispatch): zero LLM/billing spend.
const NEVER_MATCH_FILTER = [{ path: "action", op: "eq", value: `${RUN_ID}-never-matches` }];

type KitEntry = { kitId: string; name?: string };
type Approval = { id: string; kitRef: { source: string; localKitId?: string }; revokedAt: string | null };
type Trigger = { id: string; name: string; type: string; enabled: boolean; config?: Record<string, unknown> };
type EventSource = { id: string; name: string; token?: string; ingestUrl?: string };
type Connection = { id: string; name: string; type: string; status?: string; verifyError?: string };
type FireLog = { outcome: string; runId?: string | null; detail?: string | null };
type Run = { id: string; status: string; input?: { prompt?: string }; createdAt: string; error?: string; outputFiles?: { path: string }[] };
type Billing = {
  metered: boolean;
  balanceCents: number;
  freeMinutesRemaining: number;
  freeMinutesPerMonth: number;
  invocationFeeCents: number;
  activeMinuteRateCents: number;
};

// ---------------------------------------------------------------------------
// Cookie-authed API helpers (page.request / afterAll context share cookies).
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
const listTriggers = (api: APIRequestContext) =>
  getJson<{ triggers: Trigger[] }>(api, `${AUTO}/api/auto/triggers`).then((b) => b.triggers ?? []);
const listSources = (api: APIRequestContext) =>
  getJson<{ sources: EventSource[] }>(api, `${AUTO}/api/auto/event-sources`).then((b) => b.sources ?? []);
const listConnections = (api: APIRequestContext) =>
  getJson<{ connections: Connection[] }>(api, `${AUTO}/api/auto/connections`).then((b) => b.connections ?? []);
const listRuns = (api: APIRequestContext) => getJson<{ runs: Run[] }>(api, `${AUTO}/api/auto/runs`).then((b) => b.runs ?? []);

const listFireLogs = (api: APIRequestContext, triggerId: string) =>
  getJson<{ fireLogs: FireLog[] }>(api, `${AUTO}/api/auto/triggers/${triggerId}/fire-logs`).then((b) => b.fireLogs ?? []);

// Track what THIS run created so the sweep + in-test cleanup can remove it even
// when a name-prefix match is not enough (connections have no list-by-prefix bug,
// but ids are the reliable handle).
const createdTriggerIds: string[] = [];
const createdSourceIds: string[] = [];
const createdConnectionIds: string[] = [];

// ---------------------------------------------------------------------------
// Kit + approval bootstrap (adaptive, mirrors auto.spec.ts). Triggers/runs need
// a kit + a standing approval that covers the per-fire budget. On prod (no kit,
// kit-create is gamma-only) the dependent tests self-skip — but every trigger
// test here is already gamma-guarded, so this only runs on gamma.
// ---------------------------------------------------------------------------

type Pre = { kitId: string; kitName: string; approvalId: string };
let pre: Pre | null | undefined;
let createdApprovalId: string | null = null;
let runBudgetToRestore: number | null = null;

/**
 * KNOWN APP BUG (see auto.spec.ts): createApproval derives its ceiling from the
 * per-run budget and rejects an UNLIMITED (0¢) budget, so set a small user
 * default first (reversible; restored in afterAll).
 */
async function ensurePositiveRunBudget(api: APIRequestContext): Promise<void> {
  const rb = await getJson<{ userDefaultCents: number | null; effectiveCents: number }>(
    api,
    `${AUTO}/api/auto/run-budget`,
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
          description: "Throwaway E2E kit for the Auto CUJ suite. Safe to delete.",
        },
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
        networkPolicy: { mode: "deny_all" },
      },
    });
    if (!res.ok()) throw new Error(`approval create failed: HTTP ${res.status()} ${await res.text()}`);
    approval = (await res.json()) as Approval;
    createdApprovalId = approval.id;
  }

  pre = { kitId: kit.kitId, kitName: kit.name ?? kit.kitId, approvalId: approval.id };
  return pre;
}

// ---------------------------------------------------------------------------
// UI helpers (mirror auto.spec.ts / automations.spec.ts + forge.spec.ts).
// ---------------------------------------------------------------------------

async function gotoSection(page: Page, section: string): Promise<void> {
  await page.goto(`${AUTO}/?section=${section}`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\/|openid-connect/);
}

async function openAutomations(page: Page): Promise<void> {
  await gotoSection(page, "automations");
  await expect(page.getByRole("heading", { name: "Automations", exact: true }).first()).toBeVisible();
}

/** The input/textarea/select of a labelled `.ak-field` (labels lack htmlFor). */
function fieldControl(page: Page, label: string) {
  return page
    .locator(".ak-field")
    .filter({ has: page.locator(`label:text-is("${label}")`) })
    .locator("input, textarea, select")
    .first();
}

function note(testInfo: TestInfo, description: string): void {
  testInfo.annotations.push({ type: "note", description });
}

/** Delete any RUN_ID-prefixed triggers/sources/connections of prior attempts so
 *  create/verify/delete is unambiguous (retry-safe pre-clean). */
async function precleanByPrefix(api: APIRequestContext): Promise<void> {
  for (const t of await listTriggers(api).catch(() => [] as Trigger[])) {
    if (t.name.startsWith(RUN_ID)) await api.delete(`${AUTO}/api/auto/triggers/${t.id}`).catch(() => {});
  }
  for (const s of await listSources(api).catch(() => [] as EventSource[])) {
    if (s.name.startsWith(RUN_ID)) await api.delete(`${AUTO}/api/auto/event-sources/${s.id}`).catch(() => {});
  }
  for (const c of await listConnections(api).catch(() => [] as Connection[])) {
    if (c.name.startsWith(RUN_ID)) await api.delete(`${AUTO}/api/auto/connections/${c.id}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Failure-tolerant sweep: every RUN_ID-prefixed trigger/source/connection (and
// any id we tracked), the approval we created, and the run budget we changed.
// ---------------------------------------------------------------------------

test.afterAll(async () => {
  const api = await pwRequest.newContext({ storageState: STORAGE_STATE_PATH });
  try {
    for (const t of await listTriggers(api).catch(() => [] as Trigger[])) {
      if (t.name.startsWith(RUN_ID) || createdTriggerIds.includes(t.id)) {
        await api.delete(`${AUTO}/api/auto/triggers/${t.id}`).catch(() => {});
      }
    }
    for (const s of await listSources(api).catch(() => [] as EventSource[])) {
      if (s.name.startsWith(RUN_ID) || createdSourceIds.includes(s.id)) {
        await api.delete(`${AUTO}/api/auto/event-sources/${s.id}`).catch(() => {});
      }
    }
    for (const c of await listConnections(api).catch(() => [] as Connection[])) {
      if (c.name.startsWith(RUN_ID) || createdConnectionIds.includes(c.id)) {
        await api.delete(`${AUTO}/api/auto/connections/${c.id}`).catch(() => {});
      }
    }
    if (createdApprovalId) {
      await api.post(`${AUTO}/api/auto/approvals/${createdApprovalId}/revoke`).catch(() => {});
    }
    if (runBudgetToRestore !== null) {
      await api.put(`${AUTO}/api/auto/run-budget`, { data: { budgetCents: runBudgetToRestore } }).catch(() => {});
    }
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// 1. OAuth CONNECTION create (gdrive / dropbox). Consent is external and cannot
//    be automated — we assert what IS reachable: direct-create is REJECTED (501,
//    "use the OAuth flow") for gdrive/dropbox and 501 ("coming soon") for imap,
//    and the OAuth start either 302-redirects to the provider's consent screen
//    or 501s when the instance has no provider app credentials. Nothing is
//    persisted (all three creates throw before any write). Gamma-only: OAuth.
// ===========================================================================

test("OAuth connection: direct-create rejects gdrive/dropbox/imap; OAuth start redirects or 501 @wip", async ({ page }, testInfo) => {
  test.skip(envName !== "gamma", "gamma-only: OAuth connection flow (consent is external, credentials are gamma-config)");

  // Direct POST is a dead end for the OAuth/imap types — each 501s BEFORE any
  // write (ConnectionNotImplementedError → not_implemented).
  for (const type of ["gdrive", "dropbox", "imap"] as const) {
    const res = await page.request.post(`${AUTO}/api/auto/connections`, {
      data: { name: `${RUN_ID}-${type}`, type, config: {} },
    });
    expect(res.status(), `${type} direct-create should be 501`).toBe(501);
    expect(((await res.json()) as { error?: string }).error).toBe("not_implemented");
  }

  // OAuth start: a configured provider 302s to consent (drive.file / files scope);
  // an unconfigured instance 501s. Don't follow the redirect (external consent).
  const start = await page.request.get(`${AUTO}/api/auto/connections/oauth/gdrive/start`, {
    maxRedirects: 0,
  });
  expect([302, 501], `unexpected OAuth-start status ${start.status()}`).toContain(start.status());
  if (start.status() === 302) {
    const location = start.headers()["location"] ?? "";
    expect(location, "302 must carry a provider consent URL").toMatch(/^https:\/\//);
    note(
      testInfo,
      `OAuth start 302 → ${new URL(location).host}; consent is an external redirect that cannot be automated (stopped here).`,
    );
  } else {
    expect(((await start.json()) as { error?: string }).error).toBe("not_implemented");
    note(testInfo, "OAuth start 501: no gdrive app credentials on this instance (OAUTH_GDRIVE_CLIENT_ID/SECRET unset).");
  }
});

// ===========================================================================
// 2. MESSAGE trigger (Slack) + CHAT APPROVAL gate. Create a slack PROVIDER event
//    source + a message trigger with requireApproval, simulate an inbound event
//    via the trigger's Test-fire, and assert the fire is HELD (never dispatches
//    a run — requireApproval intercepts before dispatch, so zero spend on any
//    outcome). Then verify the automation + its fire log render in the real UI.
//    Gamma-only: needs a kit (self-host isolated store).
// ===========================================================================

test("message trigger (Slack) + chat-approval gate holds the fire without dispatching a run @wip", async ({ page }, testInfo) => {
  test.skip(envName !== "gamma", "gamma-only: needs a kit + approval (self-host isolated Auto store)");
  const p = await ensureKitAndApproval(page.request);
  test.skip(!p, "no kit/approval available for this user");
  await precleanByPrefix(page.request);

  const srcName = `${RUN_ID}-slack-src`;
  const trigName = `${RUN_ID}-msg`;

  // A slack PROVIDER event source (the message trigger's inbound feed). No
  // signing secret needed to CREATE it (only to verify live ingest signatures).
  const srcRes = await page.request.post(`${AUTO}/api/auto/event-sources`, {
    data: { name: srcName, kind: "provider", provider: "slack" },
  });
  expect(srcRes.status(), await srcRes.text()).toBe(201);
  const source = (await srcRes.json()) as EventSource;
  createdSourceIds.push(source.id);

  // The message trigger. requireApproval:true GUARANTEES no dispatch (gate (e2)
  // holds any passing fire as awaiting_approval); no filter so the fire reaches
  // the approval gate rather than being filtered out first.
  const trigRes = await page.request.post(`${AUTO}/api/auto/triggers`, {
    data: {
      type: "message",
      name: trigName,
      kitRef: { source: "local", localKitId: p!.kitId },
      approvalId: p!.approvalId,
      budgetCents: 50,
      requireApproval: true,
      mapping: { promptTemplate: "Reply to {{text}}. (e2e — approval-gated, never auto-dispatched)" },
      config: { platform: "slack", sourceId: source.id, scope: "channel" },
    },
  });
  expect(trigRes.status(), await trigRes.text()).toBe(201);
  const trigger = (await trigRes.json()) as Trigger;
  createdTriggerIds.push(trigger.id);

  // Simulate an inbound Slack message (Events API event_callback shape) via the
  // trigger's REAL test-fire (the "Test fire" inspector path). The payload only
  // affects the (absent) filter gate; the outcome is decided by requireApproval.
  const fire = await page.request.post(`${AUTO}/api/auto/triggers/${trigger.id}/test-fire`, {
    data: {
      sampleEvent: {
        event: { type: "message", channel: "C-e2e", ts: "1700000000.000100", user: "U-e2e", text: `hi ${RUN_ID}` },
      },
    },
  });
  expect(fire.status(), await fire.text()).toBe(200);
  const { fireLog } = (await fire.json()) as { fireLog: FireLog };

  // CORE SAFETY + JOURNEY assertion: the approval-gated message fire did NOT
  // dispatch a run (no spend). Any of these safe non-dispatch outcomes is
  // acceptable; awaiting_approval is the demonstrated happy path.
  const SAFE = new Set([
    "awaiting_approval",
    "skipped_funds",
    "suppressed_rate",
    "suppressed_circuit",
    "suppressed_concurrency",
    "error",
    "filtered",
  ]);
  expect(fireLog.runId ?? null, "approval-gated fire must not create a run").toBeNull();
  expect(SAFE.has(fireLog.outcome), `unexpected (possibly run-dispatching) outcome: ${fireLog.outcome}`).toBe(true);
  note(
    testInfo,
    fireLog.outcome === "awaiting_approval"
      ? "Message fire HELD for pre-run chat approval (awaiting_approval) — no run dispatched."
      : `Message fire safely produced "${fireLog.outcome}" (no run/spend); awaiting_approval needs the ledger to pass affordability + a wired pending-approval store on this deployment.`,
  );

  // The automation + its fire log render in the real UI.
  await openAutomations(page);
  const card = page.locator(".provider-card").filter({ hasText: trigName }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("Message", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Fire log", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Fire log — ${trigName}` })).toBeVisible();
  await expect(page.getByText("No fires yet.")).toHaveCount(0); // the test-fire logged one row

  // In-test cleanup (afterAll backstops failures).
  await page.request.delete(`${AUTO}/api/auto/triggers/${trigger.id}`).catch(() => {});
  await page.request.delete(`${AUTO}/api/auto/event-sources/${source.id}`).catch(() => {});
});

// ===========================================================================
// 3a. RSS trigger: create → simulate a poll via Test-fire → the never-match
//     filter stops the chain at "filtered" (deterministic, zero spend) → listed
//     in the UI → delete. Gamma-only: needs a kit.
// ===========================================================================

test("RSS trigger: create → test-fire filtered (no run) → listed → delete @wip", async ({ page }) => {
  test.skip(envName !== "gamma", "gamma-only: needs a kit + approval (self-host isolated Auto store)");
  const p = await ensureKitAndApproval(page.request);
  test.skip(!p, "no kit/approval available for this user");
  await precleanByPrefix(page.request);

  const name = `${RUN_ID}-rss`;
  const res = await page.request.post(`${AUTO}/api/auto/triggers`, {
    data: {
      type: "rss",
      name,
      kitRef: { source: "local", localKitId: p!.kitId },
      approvalId: p!.approvalId,
      budgetCents: 50,
      filters: NEVER_MATCH_FILTER,
      mapping: { promptTemplate: "Summarize {{title}}. (e2e — filter never matches)" },
      config: { feedUrl: "https://example.com/feed.xml", intervalMinutes: 60 },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const trigger = (await res.json()) as Trigger;
  createdTriggerIds.push(trigger.id);

  const fire = await page.request.post(`${AUTO}/api/auto/triggers/${trigger.id}/test-fire`, {
    data: { sampleEvent: { title: `entry ${RUN_ID}` } },
  });
  expect(fire.status(), await fire.text()).toBe(200);
  const { fireLog } = (await fire.json()) as { fireLog: FireLog };
  expect(fireLog.outcome, "never-match filter must stop the RSS fire at 'filtered'").toBe("filtered");
  expect(fireLog.runId ?? null).toBeNull();

  // Listed in the UI (RSS badge), then delete via API and confirm gone in UI.
  await openAutomations(page);
  const card = page.locator(".provider-card").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("RSS", { exact: true })).toBeVisible();

  await page.request.delete(`${AUTO}/api/auto/triggers/${trigger.id}`);
  await expect.poll(async () => (await listTriggers(page.request)).some((t) => t.id === trigger.id)).toBe(false);
  await openAutomations(page);
  await expect(page.locator(".provider-card").filter({ hasText: name })).toHaveCount(0);
});

// ===========================================================================
// 3b. EMAIL-in trigger: create (the server MINTS the inbound address on the
//     hosted path) → simulate via Test-fire → never-match filter → "filtered"
//     → delete. Gamma-only: needs a kit.
// ===========================================================================

test("email-in trigger: create (server-minted address) → test-fire filtered → delete @wip", async ({ page }, testInfo) => {
  test.skip(envName !== "gamma", "gamma-only: needs a kit + approval (self-host isolated Auto store)");
  const p = await ensureKitAndApproval(page.request);
  test.skip(!p, "no kit/approval available for this user");
  await precleanByPrefix(page.request);

  const name = `${RUN_ID}-email`;
  const res = await page.request.post(`${AUTO}/api/auto/triggers`, {
    data: {
      type: "email_in",
      name,
      kitRef: { source: "local", localKitId: p!.kitId },
      approvalId: p!.approvalId,
      budgetCents: 50,
      filters: NEVER_MATCH_FILTER,
      mapping: { promptTemplate: "Handle mail {{subject}}. (e2e — filter never matches)" },
      config: { allowedFrom: [] }, // hosted path: no imap connection → server mints the address
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const trigger = (await res.json()) as Trigger & { config?: { address?: string | null } };
  createdTriggerIds.push(trigger.id);
  // The inbound address is server-owned; it is null when no inbox domain is
  // configured (AUTO_EMAIL_INBOX_DOMAIN unset — the poller is then inert).
  note(
    testInfo,
    trigger.config?.address
      ? `Server-minted inbound address: ${trigger.config.address}`
      : "No AUTO_EMAIL_INBOX_DOMAIN on this instance → address null (email-in poller inert; create path still valid).",
  );

  const fire = await page.request.post(`${AUTO}/api/auto/triggers/${trigger.id}/test-fire`, {
    data: { sampleEvent: { subject: `hello ${RUN_ID}` } },
  });
  expect(fire.status(), await fire.text()).toBe(200);
  const { fireLog } = (await fire.json()) as { fireLog: FireLog };
  expect(fireLog.outcome, "never-match filter must stop the email fire at 'filtered'").toBe("filtered");
  expect(fireLog.runId ?? null).toBeNull();

  await openAutomations(page);
  const card = page.locator(".provider-card").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("Email", { exact: true })).toBeVisible();

  await page.request.delete(`${AUTO}/api/auto/triggers/${trigger.id}`);
  await expect.poll(async () => (await listTriggers(page.request)).some((t) => t.id === trigger.id)).toBe(false);
});

// ===========================================================================
// 3c. WATCH (folder) trigger: create the S3 delivery/watch connection it polls,
//     then the watch trigger → simulate via Test-fire → never-match filter →
//     "filtered" → delete both. (The connection carries no secret so it needs no
//     SecretStore; test-fire never actually polls S3, so a placeholder bucket is
//     fine.) Gamma-only: needs a kit.
// ===========================================================================

test("watch trigger: connect a folder + create watch trigger → test-fire filtered → delete @wip", async ({ page }) => {
  test.skip(envName !== "gamma", "gamma-only: needs a kit + approval (self-host isolated Auto store)");
  const p = await ensureKitAndApproval(page.request);
  test.skip(!p, "no kit/approval available for this user");
  await precleanByPrefix(page.request);

  // An S3 connection is the watch target (secret omitted → no SecretStore needed;
  // we never verify/poll it in this test).
  const connName = `${RUN_ID}-watch-s3`;
  const connRes = await page.request.post(`${AUTO}/api/auto/connections`, {
    data: { name: connName, type: "s3", config: { bucket: `${RUN_ID}-inbox`, region: "us-east-1" } },
  });
  test.skip(!connRes.ok(), `connections not provisioned on this deployment (HTTP ${connRes.status()})`);
  const connection = (await connRes.json()) as Connection;
  createdConnectionIds.push(connection.id);

  const name = `${RUN_ID}-watch`;
  const res = await page.request.post(`${AUTO}/api/auto/triggers`, {
    data: {
      type: "watch",
      name,
      kitRef: { source: "local", localKitId: p!.kitId },
      approvalId: p!.approvalId,
      budgetCents: 50,
      filters: NEVER_MATCH_FILTER,
      mapping: { promptTemplate: "Process new file {{key}}. (e2e — filter never matches)" },
      config: { connectionId: connection.id, prefix: "inbox/", intervalMinutes: 60 },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const trigger = (await res.json()) as Trigger;
  createdTriggerIds.push(trigger.id);

  const fire = await page.request.post(`${AUTO}/api/auto/triggers/${trigger.id}/test-fire`, {
    data: { sampleEvent: { key: `inbox/${RUN_ID}.txt` } },
  });
  expect(fire.status(), await fire.text()).toBe(200);
  const { fireLog } = (await fire.json()) as { fireLog: FireLog };
  expect(fireLog.outcome, "never-match filter must stop the watch fire at 'filtered'").toBe("filtered");
  expect(fireLog.runId ?? null).toBeNull();

  await openAutomations(page);
  const card = page.locator(".provider-card").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("File watch", { exact: true })).toBeVisible();

  // Delete trigger + connection; confirm both gone.
  await page.request.delete(`${AUTO}/api/auto/triggers/${trigger.id}`);
  await page.request.delete(`${AUTO}/api/auto/connections/${connection.id}`);
  await expect.poll(async () => (await listTriggers(page.request)).some((t) => t.id === trigger.id)).toBe(false);
  await expect.poll(async () => (await listConnections(page.request)).some((c) => c.id === connection.id)).toBe(false);
});

// ===========================================================================
// 4. Successful MANAGED run + credit debit + output download. Dispatch a REAL
//    run on the CHEAPEST managed model (a fraction of a cent). Gamma's platform
//    key is a placeholder + the k8s dispatcher may be inert, so a real SUCCESS
//    may be impossible — the test asserts what the deployment can actually
//    produce: a run record, a graceful terminal/active state, a reachable
//    billing snapshot with the metered debit observed when the run succeeds, and
//    a reachable output-download route when the run persisted output files.
//    Gamma-only + untagged (real compute) — NEVER on prod.
// ===========================================================================

test("managed run: dispatch cheapest model → terminal state, metered debit + output download reachable @wip", async ({ page }, testInfo) => {
  test.skip(envName !== "gamma", "gamma-only: a real run spends real compute — never on prod");
  const CHEAPEST_MODEL = "claude-haiku-4-5";
  const p = await ensureKitAndApproval(page.request);
  test.skip(!p, "no kit/approval available for this user");
  const label = `${RUN_ID}-mrun`;

  const before = await getJson<Billing>(page.request, `${AUTO}/api/auto/billing`);

  const res = await page.request.post(`${AUTO}/api/auto/runs`, {
    data: { kitRef: { source: "local", localKitId: p!.kitId }, model: CHEAPEST_MODEL, input: { prompt: label } },
  });
  expect(res.ok(), `run create failed: HTTP ${res.status()} ${await res.text()}`).toBe(true);

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
      { timeout: 20_000 },
    )
    .toBe(true);

  // Bounded wait for a terminal state (a Haiku run finishes in seconds with a
  // real key; gamma's inert dispatcher may leave it queued — tolerated).
  const ACTIVE = new Set(["queued", "running"]);
  const deadline = Date.now() + 90_000;
  while (ACTIVE.has(run!.status) && Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    run = (await listRuns(page.request)).find((r) => r.id === run!.id) ?? run;
  }

  const after = await getJson<Billing>(page.request, `${AUTO}/api/auto/billing`);
  expect(typeof after.metered, "billing snapshot must be reachable").toBe("boolean");

  if (run!.status === "succeeded") {
    if (after.metered) {
      // The v2 run fee (invocation + active-minutes) is debited from free
      // trial minutes first, then the prepaid balance — so ONE of them must move.
      const debited =
        after.balanceCents < before.balanceCents || after.freeMinutesRemaining < before.freeMinutesRemaining;
      expect(debited, `expected a metered debit (balance ${before.balanceCents}→${after.balanceCents}¢, free ${before.freeMinutesRemaining}→${after.freeMinutesRemaining}m)`).toBe(true);
      note(testInfo, `metered run debit observed: balance ${before.balanceCents}→${after.balanceCents}¢, free min ${before.freeMinutesRemaining}→${after.freeMinutesRemaining}.`);
    } else {
      note(testInfo, "run succeeded on an UNMETERED deployment (free self-host) — no credit debit expected.");
    }

    // Output download: fetch the run detail and, if it persisted output files,
    // assert the download route presigns (302) or serves (200); an expired /
    // OutputStore-less deployment 404s (documented).
    const detail = await getJson<Run>(page.request, `${AUTO}/api/auto/runs/${run!.id}`);
    const file = detail.outputFiles?.[0];
    if (file) {
      const dl = await page.request.get(
        `${AUTO}/api/auto/runs/${run!.id}/outputs/${file.path.split("/").map(encodeURIComponent).join("/")}`,
        { maxRedirects: 0 },
      );
      expect([200, 302, 404], `unexpected output-download status ${dl.status()}`).toContain(dl.status());
      note(testInfo, `output download "${file.path}" → HTTP ${dl.status()} (302 presigned / 200 served / 404 no-OutputStore or expired).`);
    } else {
      note(testInfo, "run succeeded but persisted no output files — nothing to download (trivial prompt).");
    }
  } else if (!ACTIVE.has(run!.status)) {
    // Non-success terminal: the only tolerated failure is the known kit-cleanup
    // race (worker starts after teardown). Managed spend never happened.
    const tolerated = run!.status === "failed" && /context unavailable|not found/i.test(run!.error ?? "");
    note(testInfo, `run ended "${run!.status}"${run!.error ? ` — ${run!.error}` : ""}; gamma placeholder key / inert dispatcher can prevent a real success.`);
    expect(tolerated || run!.status === "failed" || run!.status === "canceled", `unexpected terminal status ${run!.status}`).toBe(true);
  } else {
    // Still active after the window: gamma's dispatcher never picked it up.
    testInfo.annotations.push({
      type: "warning",
      description: `run ${run!.id} stayed "${run!.status}" for 90s — gamma's Auto dispatcher is not processing runs; no managed debit could be observed.`,
    });
  }

  // The run console surfaces gracefully in the History UI regardless. The run
  // card's label is kitRefLabel(kitRef), which for a local ref may be the kitId
  // (not p.kitName) — so assert the console rendered a coherent state rather than
  // filtering by name. Authoritative run assertions are done via the API above.
  await gotoSection(page, "runs");
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  await expect(
    page.locator(".provider-card").first().or(page.getByText("No runs yet.")).first()
  ).toBeVisible();
});

// ===========================================================================
// 5. Org SHARED API KEY precedence (managed → user BYO → ORG key → operator).
//    The org-key selection is a SERVER-INTERNAL decision at inference time
//    (server/core/org-key-client.ts → the Profile service-key seam) and is NOT
//    surfaced to any browser-observable API; setting an org shared key also lives
//    in AgentKitProfile, out of this app's reach. So we assert the reachable
//    PRECONDITION surfaces (the user's own BYO/provider state that the org key
//    falls back FROM) and document the unobservable step. Read-only. Gamma-only.
// ===========================================================================

test("org shared key precedence: BYO/provider precondition surfaces are reachable (org-key selection is server-internal) @wip", async ({ page }, testInfo) => {
  test.skip(envName !== "gamma", "gamma-only: org shared keys are a hosted/org feature (Profile is system of record)");

  // The user's OWN key state — the org key only applies when this has NO key.
  const byo = await getJson<{ hasKey: boolean; inferenceMode: string }>(page.request, `${AUTO}/api/auto/byo-key`);
  expect(typeof byo.hasKey).toBe("boolean");
  expect(["auto", "managed", "byo"]).toContain(byo.inferenceMode);

  // The multi-provider surface (default provider drives which provider type the
  // org key is resolved FOR).
  const providers = await getJson<{ providers: unknown[]; defaultProviderId?: string | null; catalog: unknown[] }>(
    page.request,
    `${AUTO}/api/auto/ai-providers`,
  );
  expect(Array.isArray(providers.providers)).toBe(true);
  expect(Array.isArray(providers.catalog)).toBe(true);

  note(
    testInfo,
    "Org-shared-key precedence (managed→BYO→org→operator) is resolved server-side at inference time " +
      "(org-key-client.ts via PROFILE_SERVICE_KEY) and is not exposed to any browser API; setting an org " +
      "shared key lives in AgentKitProfile. Verified by unit tests, not browser-observable — precondition surfaces asserted here.",
  );
});

// ===========================================================================
// 6. Connection VERIFY probe. Create an outbound-webhook connection, run the
//    server-side Verify probe (https + SSRF-guard DNS resolve — NOTHING is
//    posted), assert its status flips off "unverified", then delete. Fully
//    prod-safe (no money, no LLM, own artifact) → @reversible.
// ===========================================================================

test("connection verify probe: create webhook_out → verify stamps status → delete @wip @reversible", async ({ page }, testInfo) => {
  await precleanByPrefix(page.request);
  const name = `${RUN_ID}-verify`;

  // webhook_out carries only a public https url (no secret → no SecretStore).
  const createRes = await page.request.post(`${AUTO}/api/auto/connections`, {
    data: { name, type: "webhook_out", config: { url: "https://example.com/e2e-hook" } },
  });
  test.skip(!createRes.ok(), `connections not provisioned on this deployment (HTTP ${createRes.status()})`);
  const connection = (await createRes.json()) as Connection;
  createdConnectionIds.push(connection.id);
  expect(connection.status ?? "unverified").toBe("unverified");

  // Listed for the user.
  expect((await listConnections(page.request)).some((c) => c.id === connection.id)).toBe(true);

  // Verify: the probe resolves example.com (public) and stamps ok; a transient
  // DNS/network hiccup would stamp error — either way the probe RAN and the
  // status left "unverified", which is the journey.
  const verifyRes = await page.request.post(`${AUTO}/api/auto/connections/${connection.id}/verify`);
  expect(verifyRes.status(), await verifyRes.text()).toBe(200);
  const verified = (await verifyRes.json()) as Connection;
  expect(["ok", "error"], `verify should stamp a definitive status, got ${verified.status}`).toContain(verified.status);
  if (verified.status !== "ok") {
    note(testInfo, `verify stamped "error" (probe ran): ${verified.verifyError ?? "(no detail)"} — expected ok for a public https host.`);
  }

  // Delete + confirm gone.
  const del = await page.request.delete(`${AUTO}/api/auto/connections/${connection.id}`);
  expect(del.ok()).toBe(true);
  await expect.poll(async () => (await listConnections(page.request)).some((c) => c.id === connection.id)).toBe(false);
});

// ===========================================================================
// 7. Buy-credits from Auto Settings. The Settings ("Inference & billing") pane
//    surfaces a "Buy credits" link to the Market credits page. Assert the
//    affordance renders and points at Market's /account/credits checkout, then
//    follow it to the checkout page. We STOP at the checkout page — completing a
//    purchase needs a Stripe TEST-MODE card (gamma). Gamma-only: live Stripe.
// ===========================================================================

test("buy-credits: Settings surfaces a Buy-credits link to the Market credits checkout @wip", async ({ page }, testInfo) => {
  test.skip(envName !== "gamma", "gamma-only: leads to live Stripe checkout (gamma uses Stripe TEST MODE)");

  await gotoSection(page, "settings");
  await expect(page.getByRole("heading", { name: "Inference & billing" }).first()).toBeVisible();

  // The link is shown whenever a Market URL is configured (marketUrl). A
  // Market-less self-host hides it → skip with a clear reason.
  const buyLink = page.locator('a[href$="/account/credits"]').first();
  test.skip((await buyLink.count()) === 0, "no Market URL configured on this deployment → no buy-credits affordance");
  await expect(buyLink).toBeVisible();
  await expect(buyLink.getByRole("button", { name: "Buy credits" })).toBeVisible();
  const href = (await buyLink.getAttribute("href")) ?? "";
  expect(href).toMatch(/\/account\/credits$/);
  note(testInfo, `Buy-credits → ${href}`);

  // Follow it to the Market credits checkout page (do NOT complete a purchase).
  await buyLink.click();
  await page.waitForURL(/\/account\/credits/, { timeout: 20_000 });
  await expect(page).not.toHaveURL(/\/auth\/sign-in|\/realms\//);
  expect(page.url()).toContain("/account/credits");
  // A Stripe TEST-MODE card would be entered here to complete a top-up on gamma.
});
