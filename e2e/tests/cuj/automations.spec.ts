import { test, expect, request as pwRequest, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { targets, envName, RUN_ID } from "../../lib/targets";
import { hasRealSession } from "../../global-setup";

// AgentKitAuto AUTOMATIONS CUJs (event-driven expansion, Waves 1-3 surfaces):
// the When→Run→Deliver wizard, the trigger list (enable/disable/delete), and
// the custom-event path (source → token-authed emit → inspector → gate-chain
// fire log → token rotation).
//
// Same conventions as auto.spec.ts:
//   • auth from the shared storageState (cuj project);
//   • everything created here is `${RUN_ID}`-prefixed, cleaned up in-test AND
//     in a failure-tolerant afterAll sweep, registered BEFORE the first
//     UI assertion that could fail;
//   • ADAPTIVE kit path: on deployments where Auto's kit store is isolated
//     from Forge (gamma self-host) the wizard's kit picker has no options, so
//     the trigger is created via the SAME cookie /api/auto route the wizard
//     posts to, and the LIST/disable/delete journey still runs through the
//     real UI (annotated on the test).
//   • No run is ever dispatched: the wizard CUJ only creates a DISABLED-then-
//     deleted schedule automation, and the emit CUJ uses a filter that can
//     never match — the gate chain stops at `filtered`, so zero LLM/billing
//     spend on any environment.
test.skip(!hasRealSession(), "no E2E_USER/E2E_PASSWORD — CUJ checks skipped");

const AUTO = targets.auto.replace(/\/$/, "");
const FORGE = targets.forge.replace(/\/$/, "");
const STATE = fileURLToPath(new URL("../../auth/state.json", import.meta.url));
const E2E_KIT_NAME = "e2e-cuj-kit"; // shared with auto.spec.ts (stable, reused)

type KitEntry = { kitId: string; name?: string };
type Approval = { id: string; kitRef: { source: string; localKitId?: string }; revokedAt: string | null };
type Trigger = { id: string; name: string; type: string; enabled: boolean };
type EventSource = { id: string; name: string; token?: string; ingestUrl?: string };
type FireLog = { outcome: string; detail?: string | null };

async function getJson<T>(api: APIRequestContext, url: string): Promise<T> {
  const res = await api.get(url);
  if (!res.ok()) throw new Error(`GET ${url} -> HTTP ${res.status()}`);
  return (await res.json()) as T;
}

const listTriggers = (api: APIRequestContext) =>
  getJson<{ triggers: Trigger[] }>(api, `${AUTO}/api/auto/triggers`).then((b) => b.triggers ?? []);
const listSources = (api: APIRequestContext) =>
  getJson<{ sources: EventSource[] }>(api, `${AUTO}/api/auto/event-sources`).then((b) => b.sources ?? []);

/**
 * The shared-UI `Field` renders label + control as SIBLINGS without htmlFor
 * wiring (no id is passed in the wizard), so getByLabel cannot match — locate
 * the field container by its exact label text and dig for the control.
 */
function fieldByLabel(page: Page, label: string | RegExp) {
  return page
    .locator(".ak-field")
    .filter({ has: page.locator("label.ak-label", { hasText: label }) })
    .first();
}

async function openAutomations(page: Page): Promise<void> {
  await page.goto(`${AUTO}/?section=automations`);
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Shared kit + approval (mirrors auto.spec.ts's adaptive ensure logic)
// ---------------------------------------------------------------------------

type Pre = { kitId: string; approvalId: string; uiSelectable: boolean };
let pre: Pre | null | undefined;
let createdApprovalId: string | undefined;

async function ensureKitAndApproval(api: APIRequestContext): Promise<Pre | null> {
  if (pre !== undefined) return pre;
  const autoKits = await getJson<{ kits: KitEntry[] }>(api, `${AUTO}/api/kits`).then((b) => b.kits ?? []);
  let kit = autoKits[0];
  let uiSelectable = Boolean(kit);
  if (!kit) {
    if (envName !== "gamma") {
      pre = null;
      return pre;
    }
    const forgeKits = await getJson<{ kits: KitEntry[] }>(api, `${FORGE}/api/kits`).then((b) => b.kits ?? []);
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
    uiSelectable = (await getJson<{ kits: KitEntry[] }>(api, `${AUTO}/api/kits`).then((b) => b.kits ?? [])).some(
      (k) => k.kitId === kit!.kitId,
    );
  }
  const approvals = await getJson<{ approvals: Approval[] }>(api, `${AUTO}/api/auto/approvals`).then(
    (b) => b.approvals ?? [],
  );
  let approval = approvals.find((a) => a.revokedAt === null && a.kitRef.localKitId === kit.kitId);
  if (!approval) {
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
  pre = { kitId: kit.kitId, approvalId: approval.id, uiSelectable };
  return pre;
}

function noteApiFallback(testInfo: TestInfo, what: string): void {
  testInfo.annotations.push({
    type: "note",
    description: `${what} was created via the cookie /api/auto route: this deployment's Auto kit store is isolated from Forge, so the wizard's kit picker has no options (see spec header).`,
  });
}

// ---------------------------------------------------------------------------
// Failure-tolerant sweep: every RUN_ID-prefixed trigger + source, always.
// ---------------------------------------------------------------------------

test.afterAll(async () => {
  const api = await pwRequest.newContext({ storageState: STATE });
  try {
    for (const t of await listTriggers(api).catch(() => [] as Trigger[])) {
      if (t.name.startsWith(RUN_ID)) await api.delete(`${AUTO}/api/auto/triggers/${t.id}`).catch(() => {});
    }
    for (const s of await listSources(api).catch(() => [] as EventSource[])) {
      if (s.name.startsWith(RUN_ID)) await api.delete(`${AUTO}/api/auto/event-sources/${s.id}`).catch(() => {});
    }
    if (createdApprovalId) {
      await api.post(`${AUTO}/api/auto/approvals/${createdApprovalId}/revoke`).catch(() => {});
    }
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------
// CUJ 1 — the When→Run→Deliver wizard (schedule automation)
// ---------------------------------------------------------------------------

test("@reversible automations wizard: schedule automation — create, listed, disable, delete", async ({ page }, testInfo) => {
  const name = `${RUN_ID}-wizard-sched`;
  const p = await ensureKitAndApproval(page.request);
  test.skip(!p, "no kit available and not on gamma — cannot provision one on prod");

  await openAutomations(page);

  // WHEN step — always driven through the real UI.
  await page.getByRole("button", { name: "New automation" }).click();
  await fieldByLabel(page, /^Name$/).locator("input").fill(name);
  await page.getByText("On a schedule", { exact: true }).click();
  // The phrase builder must render a concrete cron preview before Next unlocks.
  await expect(page.getByText("Next runs:", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  // RUN step — kit picker options exist only on shared-store deployments.
  const kitSelect = fieldByLabel(page, "Kit to run").locator("select");
  const options = await kitSelect.locator("option").count();
  if (p!.uiSelectable && options > 1) {
    await kitSelect.selectOption({ index: 1 });
    await fieldByLabel(page, "Prompt template")
      .locator("textarea")
      .fill("List the workspace files and summarize them. (e2e — never dispatched)");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    // DELIVER step → create. No destinations: results stay in run history.
    await page.getByRole("button", { name: "Create automation", exact: true }).click();
  } else {
    // Isolated-store deployment: same payload through the wizard's own route.
    noteApiFallback(testInfo, "The schedule automation");
    const res = await page.request.post(`${AUTO}/api/auto/triggers`, {
      data: {
        type: "schedule",
        name,
        config: { cron: "0 9 * * *", timezone: "UTC" },
        kitRef: { source: "local", localKitId: p!.kitId },
        approvalId: p!.approvalId,
        budgetCents: 50,
        mapping: { promptTemplate: "List the workspace files and summarize them. (e2e — never dispatched)" },
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    await openAutomations(page);
  }

  // Listed + enabled.
  const row = page.locator(".provider-card", { hasText: name }).first();
  await expect(row).toBeVisible();
  await expect(row.locator("input[type=checkbox]")).toBeChecked();

  // Disable through the UI toggle (never fires while we finish).
  await row.locator("input[type=checkbox]").click();
  await expect(row.locator("input[type=checkbox]")).not.toBeChecked();

  // Delete through the UI; the row disappears and the API agrees.
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".provider-card", { hasText: name })).toHaveCount(0);
  expect((await listTriggers(page.request)).some((t) => t.name === name)).toBe(false);
});

// ---------------------------------------------------------------------------
// CUJ 2 — custom event source: emit → inspector → filtered fire log → rotate
// ---------------------------------------------------------------------------

test("@reversible automations events: emit hits the inspector, the gate chain filters, rotation kills the old token", async ({ page }, testInfo) => {
  const srcName = `${RUN_ID}-src`;
  const trigName = `${RUN_ID}-evt-trig`;
  const p = await ensureKitAndApproval(page.request);
  test.skip(!p, "no kit available and not on gamma — cannot provision one on prod");

  // Source via the cookie route (the UI creates sources inside the wizard;
  // the standalone journey under test here is emit → inspect → rotate).
  const createSrc = await page.request.post(`${AUTO}/api/auto/event-sources`, { data: { name: srcName } });
  expect(createSrc.status(), await createSrc.text()).toBe(201);
  const source = (await createSrc.json()) as Required<EventSource>;
  expect(source.token.length).toBeGreaterThan(20);

  // Subscribed trigger whose filter can NEVER match → the gate chain always
  // stops at `filtered`: proves ingest → fan-out → evaluation with zero runs.
  const createTrig = await page.request.post(`${AUTO}/api/auto/triggers`, {
    data: {
      type: "event",
      name: trigName,
      config: { sourceId: source.id, eventName: null },
      filters: [{ path: "action", op: "eq", value: `${RUN_ID}-never-matches` }],
      kitRef: { source: "local", localKitId: p!.kitId },
      approvalId: p!.approvalId,
      budgetCents: 50,
      mapping: { promptTemplate: "Handle {{action}}. (e2e — filter never matches)" },
    },
  });
  expect(createTrig.status(), await createTrig.text()).toBe(201);
  const trigger = (await createTrig.json()) as Trigger;

  // Emit with the source token (exactly what a curl/IoT emitter does).
  const emit = await page.request.post(`${AUTO}/api/hooks/auto/events/${source.id}/deploy_finished`, {
    headers: { "x-auto-event-token": source.token, "content-type": "application/json" },
    data: { action: "released", version: RUN_ID },
  });
  expect(emit.status()).toBe(202);

  // Fire log: exactly one `filtered` row, no run created.
  await expect
    .poll(
      async () =>
        (
          await getJson<{ logs: FireLog[] }>(page.request, `${AUTO}/api/auto/triggers/${trigger.id}/fire-logs`)
        ).logs.map((l) => l.outcome),
      { timeout: 15_000 },
    )
    .toEqual(["filtered"]);

  // Inspector UI shows the received event on the source.
  await openAutomations(page);
  const srcRow = page.locator(".provider-card", { hasText: srcName }).first();
  await expect(srcRow).toBeVisible();
  await srcRow.getByRole("button", { name: "Events", exact: true }).click();
  await expect(page.getByText("deploy_finished").first()).toBeVisible();
  await expect(page.getByText(RUN_ID, { exact: false }).first()).toBeVisible();

  // Rotate through the UI → the shown-once dialog appears and the old token
  // is dead (uniform terse 401).
  await srcRow.getByRole("button", { name: "Rotate token", exact: true }).click();
  await expect(page.getByRole("heading", { name: `New token for "${srcName}"` })).toBeVisible();
  const oldTokenEmit = await page.request.post(`${AUTO}/api/hooks/auto/events/${source.id}/deploy_finished`, {
    headers: { "x-auto-event-token": source.token, "content-type": "application/json" },
    data: { action: "again" },
  });
  expect(oldTokenEmit.status()).toBe(401);

  // Cleanup in-test (the afterAll sweep backstops failures).
  await page.request.delete(`${AUTO}/api/auto/triggers/${trigger.id}`);
  await page.request.delete(`${AUTO}/api/auto/event-sources/${source.id}`);
});
