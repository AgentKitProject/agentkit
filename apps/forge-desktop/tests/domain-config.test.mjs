import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canonicalDomain = "https://forge.agentkitproject.com";
const legacyDomain = "https://agentkitforge.com";
const marketKitsUrl = "https://market.agentkitproject.com/kits";
const updaterPath = "/updates/latest.json";

test("Tauri updater points only at the canonical Forge domain", async () => {
  const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  const endpoints = config.plugins?.updater?.endpoints;

  assert.ok(Array.isArray(endpoints), "updater endpoints must be configured");
  assert.equal(endpoints[0], `${canonicalDomain}${updaterPath}`);
  // Legacy domain decommissioned: it must no longer appear as an updater endpoint.
  assert.ok(
    !endpoints.some((endpoint) => endpoint.startsWith(legacyDomain)),
    "legacy updater endpoint must be removed after TLD consolidation",
  );
});

test("frontend external links use canonical Forge domain", async () => {
  const appSource = await readFile("src/App.tsx", "utf8");

  assert.match(appSource, /https:\/\/forge\.agentkitproject\.com\//);
  assert.doesNotMatch(appSource, /openDocsLink\("https:\/\/agentkitforge\.com/);
});

test("Rust external URL allowlist uses canonical links and drops the legacy domain", async () => {
  const rustSource = await readFile("src-tauri/src/lib.rs", "utf8");

  for (const path of ["/", "/docs/", "/agent-kit-spec/"]) {
    assert.match(rustSource, new RegExp(`${canonicalDomain.replaceAll(".", "\\.")}${path.replaceAll("/", "\\/")}`));
  }

  // Legacy domain decommissioned: it must no longer be in the external URL allowlist.
  assert.doesNotMatch(rustSource, new RegExp(legacyDomain.replaceAll(".", "\\.")));

  assert.match(rustSource, /https:\/\/profile\.agentkitproject\.com\/account/);
  assert.match(rustSource, /https:\/\/market\.agentkitproject\.com/);
  assert.match(rustSource, /https:\/\/market\.agentkitproject\.com\/kits/);
});

test("integration foundation keeps local Forge features account-optional", async () => {
  const integrationSource = await readFile("src/integrations.ts", "utf8");
  const appSource = await readFile("src/App.tsx", "utf8");

  assert.match(integrationSource, /export type IntegrationId = "agentkitproject" \| "agentkitmarket" \| "agentkitauto"/);
  assert.match(integrationSource, /export type IntegrationStatus = "disabled" \| "disconnected" \| "connected" \| "error" \| "comingSoon"/);
  assert.match(integrationSource, /export type ExternalServiceConnection = \{/);
  assert.match(integrationSource, /serviceType: ExternalServiceType/);
  assert.match(integrationSource, /kind: ExternalServiceKind/);
  assert.match(integrationSource, /authMode: ExternalServiceAuthMode/);
  assert.match(integrationSource, /export function canUseLocalForgeFeatures\(\) \{\n  return true;\n\}/);
  assert.match(integrationSource, /export function canUseManualPackageImport\(\) \{\n  return true;\n\}/);
  assert.match(integrationSource, /export function canUseManualMarketImport\(\) \{\n  return canUseManualPackageImport\(\);\n\}/);
  assert.match(integrationSource, /canUseHostedMarketBrowse\(connection: ExternalServiceConnection\)/);
  assert.match(integrationSource, /canUseMarketSubmit\(connection: ExternalServiceConnection\)/);
  assert.match(integrationSource, /canUseMarketImport\(connection: ExternalServiceConnection\)/);
  assert.match(integrationSource, /canUseDirectMarketImport\(connection: ExternalServiceConnection\)/);
  assert.match(integrationSource, /canUseAuto\(connection: ExternalServiceConnection\)/);
  assert.match(appSource, /AgentKitForge works locally without an account\./);
  assert.match(appSource, /AgentKitProject account/);
  assert.match(appSource, /AgentKitMarket/);
  assert.match(appSource, /AgentKitAuto/);
  assert.doesNotMatch(integrationSource, /accessToken|refreshToken|idToken|access_token|refresh_token|id_token|apiKey|clientSecret|client_secret/i);
});

test("Market browse/import foundation keeps manual import local and direct import disabled", async () => {
  const integrationSource = await readFile("src/integrations.ts", "utf8");
  const appSource = await readFile("src/App.tsx", "utf8");
  const rustSource = await readFile("src-tauri/src/lib.rs", "utf8");
  const frontendBackendSource = [integrationSource, appSource, rustSource].join("\n");

  assert.match(integrationSource, new RegExp(`marketKits: "${marketKitsUrl.replaceAll(".", "\\.")}"`));
  assert.match(appSource, /data-testid="market-import-panel"/);
  assert.match(appSource, /Market sources/);
  assert.match(appSource, /Hosted AgentKitMarket/);
  assert.match(appSource, /Private\/self-hosted markets coming later/);
  assert.match(appSource, /Open AgentKitMarket/);
  assert.match(appSource, /Open Market in browser/);
  assert.match(appSource, /Direct import from Market/);
  assert.match(appSource, /Import from \.agentkit\.zip/);
  assert.match(appSource, /Connect AgentKitProject account to download directly from hosted AgentKitMarket/);
  assert.match(appSource, /Downloading from hosted Market may require an AgentKitProject account/);
  assert.match(appSource, /Importing a downloaded \.agentkit\.zip in Forge does not require login/);
  assert.match(appSource, /Manual \.agentkit\.zip import works without any Market connection/);
  assert.match(appSource, /Browse AgentKitMarket/);
  assert.match(appSource, /onClick=\{onOpenZipImport\}/);
  assert.match(rustSource, new RegExp(marketKitsUrl.replaceAll(".", "\\.")));
  assert.doesNotMatch(appSource, /From Agent Kit Market[\\s\\S]*Coming later/);
  assert.doesNotMatch(frontendBackendSource, /AGENTKITMARKET_ADMIN_KEY|PROFILE_SERVICE_KEY|WORKOS_API_KEY|WORKOS_COOKIE_PASSWORD|MARKET_ADMIN|SERVICE_KEY/);
});

test("direct hosted Market import downloads with bearer auth and imports locally", async () => {
  const appSource = await readFile("src/App.tsx", "utf8");
  const rustSource = await readFile("src-tauri/src/lib.rs", "utf8");
  const authSource = await readFile("src-tauri/src/account_auth.rs", "utf8");
  // Phase 0: backend command invocations moved behind the typed ForgeClient.
  // The literal invoke() command strings now live in the Tauri client wrapper.
  const tauriClientSource = await readFile("src/forge-client/tauri-client.ts", "utf8");
  const source = [appSource, rustSource, authSource, tauriClientSource].join("\n");

  assert.match(rustSource, /fn import_hosted_market_kit/);
  // The authenticated download now delegates to the core `market` module via the
  // one-shot operation bridge (download op writes the verified .agentkit.zip);
  // the app keeps its package-import + library persistence.
  assert.match(rustSource, /run_market_operation_bridge\(&app, "download"/);
  assert.match(rustSource, /resolve_market_operation_bridge/);
  assert.match(rustSource, /"outputPath"/);
  assert.match(rustSource, /sha256_for_file/);
  // Lifecycle/status mapping and the authed-request helper remain in Rust for
  // the display-name resolution path.
  assert.match(rustSource, /hosted_market_lifecycle_message_from_body/);
  assert.match(rustSource, /"removed" \| "withdrawn" \| "hidden"/);
  assert.match(rustSource, /This kit listing is no longer available in AgentKitMarket/);
  assert.match(rustSource, /"expired" \| "deleted" \| "not_found" \| "archived"/);
  assert.match(rustSource, /This Market listing is no longer available/);
  assert.match(rustSource, /import_agent_kit_package/);
  assert.match(rustSource, /add_kit_to_library/);
  assert.match(rustSource, /KitLibrarySource::Market/);
  assert.match(rustSource, /market_base_url/);
  assert.match(rustSource, /source_market_slug/);
  assert.match(rustSource, /remove_library_owned_kit_files/);
  assert.match(rustSource, /fs::remove_dir_all\(&canonical_kit\)/);
  assert.match(rustSource, /"built" \| "imported" \| "local_import" \| "market"/);
  assert.match(rustSource, /RemoveKitFromLibraryResult/);
  assert.match(authSource, /pub fn load_access_token/);
  assert.match(authSource, /pub fn require_access_token/);
  // Rotated sessions from core's mid-op refresh are persisted back to secure
  // storage via this helper.
  assert.match(authSource, /pub fn persist_rotated_session_json/);
  assert.match(authSource, /pub fn current_session_json/);
  assert.match(tauriClientSource, /import_hosted_market_kit/);
  assert.match(appSource, /forge\.importHostedMarketKit/);
  assert.match(tauriClientSource, /restore_agentkitproject_account/);
  assert.match(appSource, /forge\.restoreAgentKitProjectAccount/);
  assert.match(appSource, /onSettingsChange\(restoredSettings\)/);
  assert.match(appSource, /restoredSettings\.accountConnection\.accountConnectionStatus !== "connected"/);
  assert.match(appSource, /requesting"\s*\|\s*"downloading"\s*\|\s*"verifying"\s*\|\s*"importing"\s*\|\s*"validating"/);
  assert.match(appSource, /Added \{result\.metadata\.name\} \{formatDisplayVersion\(result\.metadata\.version\)\} to My Kits/);
  assert.match(appSource, /Open in My Kits/);
  assert.match(appSource, /Use Kit/);
  assert.match(appSource, /AgentKitProject session expired or is missing/);
  assert.match(appSource, /Manual \.agentkit\.zip import works without any Market connection/);
  assert.match(appSource, /stored in Forge's local library folder/);
  assert.match(appSource, /deleted locally/);
  assert.match(appSource, /Kit removal failed:/);
  assert.match(appSource, /pendingRemovalPath/);
  assert.match(appSource, /Confirm remove/);
  assert.match(appSource, /Removing\.\.\./);
  assert.match(appSource, /setPendingRemovalPath\(null\)/);
  assert.doesNotMatch(source, /AGENTKITMARKET_ADMIN_KEY|PROFILE_SERVICE_KEY|WORKOS_API_KEY|WORKOS_COOKIE_PASSWORD|Authorization.*admin/i);
});

test("hosted Market submit validates, packages, and uploads with user auth", async () => {
  const appSource = await readFile("src/App.tsx", "utf8");
  const rustSource = await readFile("src-tauri/src/lib.rs", "utf8");
  const tauriClientSource = await readFile("src/forge-client/tauri-client.ts", "utf8");
  const frontendBackendSource = [appSource, rustSource, tauriClientSource].join("\n");

  assert.match(rustSource, /fn submit_hosted_market_kit/);
  assert.match(rustSource, /validate_agent_kit\(/);
  // After the core-parity migration, the package/upload/validate flow AND the
  // publisher resolution delegate to the core `market` module via the one-shot
  // operation bridge. The Market server authoritatively resolves the publisher,
  // so Forge no longer pre-resolves the display name or refreshes the token in
  // this path — core is the SINGLE token-refresh owner (so single-use WorkOS
  // refresh tokens are never double-spent). The session is passed to the bridge
  // over STDIN, never argv.
  assert.match(rustSource, /run_market_operation_bridge\(&app, "submit"/);
  assert.match(rustSource, /resolve_market_operation_bridge/);
  assert.match(rustSource, /run_backend_script_with_stdin/);
  // No identity is ever leaked as the publisher id.
  assert.doesNotMatch(rustSource, /publisher_id:\s*.*user_id|publisher_id:\s*.*userId|publisher_id:\s*.*email/i);
  // The backend's duplicate-submission (409) condition is surfaced to the user.
  assert.match(rustSource, /Hosted AgentKitMarket already has an active submission for this kit\/version/);
  assert.match(appSource, /data-testid="market-submit-panel"/);
  assert.match(appSource, /Submit to Market/);
  assert.match(tauriClientSource, /restore_agentkitproject_account/);
  assert.match(appSource, /forge\.restoreAgentKitProjectAccount/);
  assert.match(tauriClientSource, /validate_agent_kit/);
  assert.match(appSource, /forge\.validateAgentKit/);
  assert.match(tauriClientSource, /submit_hosted_market_kit/);
  assert.match(appSource, /forge\.submitHostedMarketKit/);
  assert.match(appSource, /data-testid="market-submit-progress"/);
  assert.match(appSource, /Submission ID/);
  assert.match(appSource, /Market link/);
  assert.match(appSource, /Market admin approval is still required before publishing/);
  assert.match(appSource, /type MarketSubmissionStatus/);
  assert.match(appSource, /validation_failed/);
  assert.match(appSource, /approved/);
  assert.match(appSource, /rejected/);
  assert.match(appSource, /published/);
  assert.match(appSource, /canceled/);
  assert.match(appSource, /removed/);
  assert.match(appSource, /deleted/);
  assert.match(appSource, /expired/);
  assert.match(appSource, /archived/);
  assert.match(appSource, /formatMarketSubmissionStatus\(result\.status\)/);
  assert.match(appSource, /Reconnect AgentKitProject account to submit to hosted AgentKitMarket/);
  assert.match(appSource, /Private markets use their own credentials and identity provider/);
  assert.doesNotMatch(frontendBackendSource, /AGENTKITMARKET_ADMIN_KEY|PROFILE_SERVICE_KEY|WORKOS_API_KEY|WORKOS_COOKIE_PASSWORD|MARKET_ADMIN|SERVICE_KEY/);
});

test("AgentKitProject connected state requires secure token session", async () => {
  const appSource = await readFile("src/App.tsx", "utf8");
  const rustSource = await readFile("src-tauri/src/lib.rs", "utf8");
  const authSource = await readFile("src-tauri/src/account_auth.rs", "utf8");
  const settingsSource = await readFile("src-tauri/src/settings.rs", "utf8");
  const secureStorageSource = await readFile("src-tauri/src/secure_storage.rs", "utf8");
  const source = [appSource, rustSource, authSource, settingsSource, secureStorageSource].join("\n");

  assert.match(authSource, /struct StoredAccountSession[\s\S]*access_token: String/);
  assert.match(authSource, /secure_storage::store_account_session\(&session_json\)/);
  assert.match(authSource, /expected_access_token\.is_empty\(\)/);
  assert.match(authSource, /secure_storage::load_account_session\(\)\?/);
  assert.match(authSource, /verified_access_token != expected_access_token/);
  assert.match(authSource, /Keychain domain:/);
  assert.match(authSource, /secure_storage::SERVICE_NAME/);
  assert.match(authSource, /secure_storage::SESSION_ACCOUNT/);
  assert.match(authSource, /settings::save_connected_account/);
  assert.ok(
    authSource.indexOf("secure_storage::store_account_session(&session_json)?") <
      authSource.indexOf("settings::save_connected_account"),
    "login should store the secure session before persisting connected metadata",
  );
  assert.match(authSource, /pub fn restore_account_from_secure_storage/);
  assert.match(authSource, /secure_storage::load_account_session\(\)/);
  assert.match(authSource, /settings::account_metadata_present\(app\)\?/);
  assert.match(authSource, /settings::save_account_reconnect_required/);
  assert.match(authSource, /Err\(_\) => \{/);
  assert.match(authSource, /session\.access_token\.trim\(\)\.is_empty\(\)/);
  assert.match(authSource, /RECONNECT_REQUIRED: Reconnect AgentKitProject account/);
  assert.match(rustSource, /fn check_agentkitproject_account_session/);
  assert.match(authSource, /pub struct AccountSessionDiagnostics/);
  assert.match(authSource, /account_metadata_present/);
  assert.match(authSource, /token_present/);
  assert.match(authSource, /token_expired/);
  assert.match(authSource, /secure_storage_available/);
  assert.match(authSource, /secure_storage_service_name/);
  assert.match(authSource, /secure_storage_session_account/);
  assert.match(authSource, /secure_storage_keychain_domain/);
  assert.match(secureStorageSource, /pub const SERVICE_NAME: &str = "com\.agentkitforge\.desktop\.agentkitproject"/);
  assert.match(secureStorageSource, /pub const SESSION_ACCOUNT: &str = "agentkitproject-session"/);
  assert.match(secureStorageSource, /pub const KEYCHAIN_DOMAIN: &str = "User"/);
  assert.match(secureStorageSource, /pub fn verify_account_session/);
  assert.match(secureStorageSource, /could not be found during OS secure storage readback/);
  assert.match(appSource, /isReconnectRequiredError/);
  assert.match(appSource, /Reconnect AgentKitProject account to download directly from hosted AgentKitMarket/);
  assert.match(appSource, /onAccountReconnectRequired\(reconnectMessage\)/);
  assert.match(appSource, /accountConnectionStatus: "error"/);
  assert.match(appSource, /Reconnect account/);
  assert.match(authSource, /secure_storage::clear_account_session\(\)\?/);
  assert.match(settingsSource, /settings\.account_connection = Some\(disconnected_account_connection\(\)\)/);
  assert.doesNotMatch(source, /eprintln!\([^)]*access_token|println!\([^)]*access_token|console\.log\([^)]*token|console\.log\([^)]*Authorization/i);
});

test("Market import deep links register protocol and carry references only", async () => {
  const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  const capability = JSON.parse(await readFile("src-tauri/capabilities/default.json", "utf8"));
  const cargoToml = await readFile("src-tauri/Cargo.toml", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const appSource = await readFile("src/App.tsx", "utf8");

  assert.deepEqual(config.plugins?.["deep-link"]?.desktop?.schemes, ["agentkitforge"]);
  assert.ok(capability.permissions.includes("deep-link:default"));
  assert.match(cargoToml, /tauri-plugin-deep-link = "2"/);
  assert.equal(packageJson.dependencies["@tauri-apps/plugin-deep-link"].startsWith("^2."), true);
  assert.match(appSource, /parseMarketImportDeepLink/);
  assert.match(appSource, /agentkitforge:/);
  assert.match(appSource, /url\.hostname !== "market"/);
  assert.match(appSource, /url\.pathname !== "\/import"/);
  assert.match(appSource, /url\.searchParams\.get\("market"\)/);
  assert.match(appSource, /url\.searchParams\.get\("kit"\)/);
  assert.match(appSource, /url\.searchParams\.get\("kitId"\)/);
  assert.match(appSource, /requiresConfirmation: true/);
  assert.match(appSource, /data-testid="market-import-confirmation"/);
  assert.match(appSource, /Import this kit from \{marketBaseUrl\}\?/);
  assert.match(appSource, /Confirm and import/);
});

test("Market import rejects unsafe deep-link and URL parameters", async () => {
  const appSource = await readFile("src/App.tsx", "utf8");

  assert.match(appSource, /function blockedMarketImportParam\(searchParams: URLSearchParams\)/);
  for (const blocked of [
    /normalized === "downloadurl"/,
    /normalized\.includes\("token"\)/,
    /normalized\.includes\("auth"\)/,
    /normalized\.includes\("secret"\)/,
    /normalized\.includes\("adminkey"\)/,
    /normalized\.includes\("servicekey"\)/,
    /normalized === "apikey"/,
    /normalized === "access_key"/,
  ]) {
    assert.match(appSource, blocked);
  }
  assert.match(appSource, /Market import links cannot include/);
  assert.match(appSource, /Market import URLs cannot include/);
  assert.doesNotMatch(appSource, /downloadUrl:\s*downloadUrl|downloadUrl:\s*url|accessToken:\s*|Authorization:\s*`Bearer/i);
});

test("Market import normalizes manual URL, slug, and kit ID references safely", async () => {
  const appSource = await readFile("src/App.tsx", "utf8");

  assert.match(appSource, /function normalizeMarketImportReference/);
  assert.match(appSource, /const pathParts = url\.pathname\.split\("\/"\)\.filter\(Boolean\)/);
  assert.match(appSource, /const kitsIndex = pathParts\.indexOf\("kits"\)/);
  assert.match(appSource, /url\.searchParams\.get\("kitId"\)/);
  assert.match(appSource, /url\.searchParams\.get\("kit"\)/);
  assert.match(appSource, /marketValidation\.marketBaseUrl/);
  assert.match(appSource, /identifierKind: kitId \? "kitId" : "kit"/);
  assert.match(appSource, /Market kit URL, slug, or ID/);
  assert.match(appSource, /Slug \/ URL/);
  assert.match(appSource, /Kit ID/);
  assert.match(appSource, /placeholder="https:\/\/market\.agentkitproject\.com\/kits\/example-kit-slug, example-kit-slug, or kit_123"/);
});

test("Market URL validation requires HTTPS except localhost and rejects credentials", async () => {
  const appSource = await readFile("src/App.tsx", "utf8");

  assert.match(appSource, /function normalizeMarketBaseUrl/);
  assert.match(appSource, /marketUrl\.username \|\| marketUrl\.password/);
  assert.match(appSource, /Market URL must not include credentials/);
  assert.match(appSource, /marketUrl\.protocol !== "https:"/);
  assert.match(appSource, /marketUrl\.protocol === "http:" && isLocalDevHost\(marketUrl\.hostname\)/);
  assert.match(appSource, /Market URL must use HTTPS unless it is localhost for development/);
  assert.match(appSource, /hostname === "localhost"/);
  assert.match(appSource, /hostname === "127\.0\.0\.1"/);
  assert.match(appSource, /hostname === "::1"/);
});

test("private Market direct import placeholder does not require AgentKitProject login", async () => {
  const appSource = await readFile("src/App.tsx", "utf8");

  assert.match(appSource, /Private Market import will use this Market's own credentials\. Coming soon\./);
  assert.match(appSource, /isConnected \|\| !selectedHostedMarket/);
  assert.match(appSource, /if \(!isHostedAgentKitMarket\(request\.marketBaseUrl\)\) \{/);
  assert.match(appSource, /AgentKitProject account is not required unless that market chooses it/);
});

test("external service connection defaults support hosted and private Market and Auto", async () => {
  const integrationSource = await readFile("src/integrations.ts", "utf8");
  const appSource = await readFile("src/App.tsx", "utf8");
  const settingsSource = await readFile("src-tauri/src/settings.rs", "utf8");

  assert.match(integrationSource, /id: "agentkitproject-market"/);
  assert.match(integrationSource, /name: "AgentKitMarket"/);
  assert.match(integrationSource, /serviceType: "market"/);
  assert.match(integrationSource, /kind: "agentkitproject_hosted"/);
  assert.match(integrationSource, /authMode: "agentkitproject"/);
  assert.match(integrationSource, /browse: true/);
  assert.match(integrationSource, /download: true/);
  assert.match(integrationSource, /submit: true/);
  assert.match(integrationSource, /import: false/);
  assert.match(integrationSource, /id: "private-market-placeholder"/);
  assert.match(integrationSource, /id: "agentkitproject-auto"/);
  assert.match(integrationSource, /baseUrl: agentKitProjectUrls\.auto/);
  assert.match(integrationSource, /id: "private-auto-placeholder"/);
  assert.match(appSource, /data-testid="hosted-market-card"/);
  assert.match(appSource, /data-testid="private-market-card"/);
  assert.match(appSource, /data-testid="hosted-auto-card"/);
  assert.match(appSource, /data-testid="private-auto-card"/);
  assert.match(appSource, /Private markets use their own credentials and identity provider/);
  assert.match(appSource, /AgentKitProject account is not required unless that market chooses it/);
  assert.match(appSource, /Company\/private Auto instances should use their own self-managed auth/);
  assert.match(appSource, /Private Market base URL/);
  assert.match(appSource, /Private Auto base URL/);
  assert.match(appSource, /Add private Market/);
  assert.doesNotMatch(settingsSource, /accessToken|refreshToken|idToken|access_token|refresh_token/);
});

test("AgentKitAuto is inert coming-soon scaffolding with no execution wiring", async () => {
  const integrationSource = await readFile("src/integrations.ts", "utf8");
  const appSource = await readFile("src/App.tsx", "utf8");

  // Connection model: hosted + self-hosted Auto entries, opt-in, off by default.
  assert.match(integrationSource, /serviceType: "auto"/);
  assert.match(integrationSource, /status: "comingSoon"/);
  // Auto capability gate exists and is conservative (requires a real connection).
  assert.match(integrationSource, /canUseAuto\(connection: ExternalServiceConnection\)/);
  assert.match(integrationSource, /connection\.serviceType === "auto" && connection\.status === "connected" && connection\.capabilities\.runAutomation === true/);
  // Auto placeholders ship with automation explicitly disabled.
  assert.match(integrationSource, /runAutomation: false/);

  // UI: Auto section + both cards, marked Coming soon, opt-in only.
  assert.match(appSource, /data-testid="auto-integrations-section"/);
  assert.match(appSource, /data-testid="hosted-auto-card"/);
  assert.match(appSource, /data-testid="private-auto-card"/);
  assert.match(appSource, /Hosted AgentKitAuto will use your optional AgentKitProject account when it becomes available\./);
  assert.match(appSource, /Add Auto connection later/);

  // Inertness: no execution/upload/scheduling/network wiring for Auto.
  assert.doesNotMatch(appSource, /run_automation|runAutomation\(|invoke\([^)]*auto/i);
  assert.doesNotMatch(integrationSource, /fetch\(|invoke\(|setInterval|setTimeout/);
});

test("Account view and sidebar account block are first-class signed-out UX", async () => {
  const appSource = await readFile("src/App.tsx", "utf8");

  assert.match(appSource, /type ExtendedSectionId = SectionId \| "package-export" \| "market-submit" \| "install-targets" \| "run-chat" \| "account" \| "about"/);
  assert.match(appSource, /label: "Account"/);
  assert.match(appSource, /data-testid="sidebar-account-block"/);
  assert.match(appSource, /Not signed in/);
  assert.match(appSource, /Connect account/);
  assert.match(appSource, /function AccountScreen/);
  assert.match(appSource, /data-testid="account-view"/);
  assert.match(appSource, /Create Agent Kits, edit kits, Build with AI, validate, package, export, import local packages, and manage My Kits without signing in\./);
  assert.doesNotMatch(appSource, /sidebarAccountName[\\s\\S]*userId/);
});

test("desktop account login uses WorkOS device auth and secure storage", async () => {
  const appSource = await readFile("src/App.tsx", "utf8");
  const rustSource = await readFile("src-tauri/src/lib.rs", "utf8");
  const authSource = await readFile("src-tauri/src/account_auth.rs", "utf8");
  const secureStorageSource = await readFile("src-tauri/src/secure_storage.rs", "utf8");
  const settingsSource = await readFile("src-tauri/src/settings.rs", "utf8");
  const tauriClientSource = await readFile("src/forge-client/tauri-client.ts", "utf8");

  assert.match(tauriClientSource, /begin_agentkitproject_account_login/);
  assert.match(appSource, /forge\.beginAgentKitProjectAccountLogin/);
  assert.match(tauriClientSource, /complete_agentkitproject_account_login/);
  assert.match(appSource, /forge\.completeAgentKitProjectAccountLogin/);
  assert.match(tauriClientSource, /restore_agentkitproject_account/);
  assert.match(appSource, /forge\.restoreAgentKitProjectAccount/);
  assert.match(tauriClientSource, /check_agentkitproject_auth_config/);
  assert.match(appSource, /forge\.checkAgentKitProjectAuthConfig/);
  assert.match(appSource, /missingPublicConfigKeys/);
  assert.match(appSource, /Connecting\.\.\./);
  assert.match(appSource, /Verification code/);
  assert.match(rustSource, /begin_agentkitproject_account_login/);
  assert.match(rustSource, /complete_agentkitproject_account_login/);
  assert.match(rustSource, /restore_agentkitproject_account/);
  assert.match(rustSource, /check_agentkitproject_auth_config/);
  assert.match(authSource, /WORKOS_DEVICE_AUTH_URL/);
  assert.match(authSource, /const AGENTKITPROJECT_WORKOS_CLIENT_ID_KEY: &str = "AGENTKITPROJECT_WORKOS_CLIENT_ID"/);
  assert.match(authSource, /std::env::var\(AGENTKITPROJECT_WORKOS_CLIENT_ID_KEY\)/);
  assert.match(authSource, /option_env!\("AGENTKITPROJECT_WORKOS_CLIENT_ID"\)/);
  assert.match(authSource, /pub struct AccountAuthConfigDiagnostics/);
  assert.match(authSource, /missing_public_config_keys/);
  assert.match(authSource, /client_id_source/);
  assert.match(authSource, /profile_base_url: "https:\/\/profile\.agentkitproject\.com"/);
  assert.match(authSource, /market_base_url: "https:\/\/market\.agentkitproject\.com"/);
  assert.match(authSource, /forge_base_url: "https:\/\/forge\.agentkitproject\.com"/);
  assert.match(authSource, /Missing public config key: AGENTKITPROJECT_WORKOS_CLIENT_ID/);
  assert.match(authSource, /urn:ietf:params:oauth:grant-type:device_code/);
  assert.match(authSource, /verification_uri_complete/);
  assert.match(authSource, /authorization_pending/);
  assert.match(authSource, /slow_down/);
  assert.match(authSource, /access_denied/);
  assert.match(authSource, /secure_storage::store_account_session/);
  assert.match(secureStorageSource, /keyring::Entry/);
  assert.match(secureStorageSource, /secret\.trim\(\)\.is_empty\(\)/);
  assert.match(secureStorageSource, /verify_account_session\(secret\)/);
  assert.match(secureStorageSource, /set_password/);
  assert.match(secureStorageSource, /get_password/);
  assert.match(secureStorageSource, /delete_credential/);
  assert.doesNotMatch(settingsSource, /accessToken|refreshToken|idToken|access_token|refresh_token/);
  assert.doesNotMatch(appSource, /deviceCode|device_code/);
});

test("release workflows require hosted AgentKitProject public auth config", async () => {
  const releasePlease = await readFile(".github/workflows/release-please.yml", "utf8");
  const releaseArtifacts = await readFile(".github/workflows/release-artifacts.yml", "utf8");
  const releaseProcess = await readFile("RELEASE_PROCESS.md", "utf8");

  for (const workflow of [releasePlease, releaseArtifacts]) {
    assert.match(workflow, /Validate hosted AgentKitProject auth public config/);
    assert.match(workflow, /AGENTKITPROJECT_WORKOS_CLIENT_ID: \$\{\{ vars\.AGENTKITPROJECT_WORKOS_CLIENT_ID \}\}/);
    assert.match(workflow, /AGENTKITPROJECT_WORKOS_CLIENT_ID repository variable is required/);
    assert.match(workflow, /npm run build:tauri[\s\S]*AGENTKITPROJECT_WORKOS_CLIENT_ID: \$\{\{ vars\.AGENTKITPROJECT_WORKOS_CLIENT_ID \}\}/);
  }

  assert.match(releaseProcess, /GitHub repository variable/);
  assert.match(releaseProcess, /compile-time env/);
  assert.doesNotMatch(releasePlease + releaseArtifacts, /WORKOS_API_KEY|WORKOS_COOKIE_PASSWORD|AGENTKITMARKET_ADMIN_KEY|PROFILE_SERVICE_KEY/);
});

test("GitHub Actions macOS packaging remains explicit after local build wrapper change", async () => {
  const smoke = await readFile(".github/workflows/smoke.yml", "utf8");
  const releasePlease = await readFile(".github/workflows/release-please.yml", "utf8");
  const releaseArtifacts = await readFile(".github/workflows/release-artifacts.yml", "utf8");

  assert.match(smoke, /runner\.os == 'macOS'[\s\S]*npm run build:tauri -- --bundles app/);
  for (const workflow of [releasePlease, releaseArtifacts]) {
    assert.match(workflow, /matrix\.platform == 'macos'[\s\S]*npm run build:tauri -- --config src-tauri\/tauri\.updater\.conf\.json --bundles app/);
    assert.match(workflow, /Bundle signed macOS DMG[\s\S]*npm exec tauri -- bundle --config src-tauri\/tauri\.updater\.conf\.json --bundles dmg/);
    assert.match(workflow, /Finalize signed macOS release artifacts[\s\S]*--skip-jenkins/);
  }
});

test("local macOS builds auto-handle Node sidecar and DMG wrapper gotchas", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const backendScript = await readFile("scripts/build-backend.mjs", "utf8");
  const tauriBuildScript = await readFile("scripts/build-tauri.mjs", "utf8");

  assert.equal(packageJson.scripts["build:tauri"], "node scripts/build-tauri.mjs");
  assert.match(backendScript, /AGENTKITFORGE_NODE_SIDECAR/);
  assert.match(backendScript, /\/Applications\/AgentKitForge\.app\/Contents\/MacOS\/node/);
  assert.match(backendScript, /No bundleable Node sidecar candidate was found/);
  assert.match(backendScript, /Using fallback Node sidecar candidate/);
  assert.match(tauriBuildScript, /--bundles", "app"/);
  assert.match(tauriBuildScript, /avoid Tauri's generated DMG wrapper/);
  assert.match(tauriBuildScript, /signLocalMacosAppIfNeeded/);
  assert.match(tauriBuildScript, /com\.agentkitforge\.desktop/);
  assert.match(tauriBuildScript, /node-sidecar\.entitlements\.plist/);
  assert.match(tauriBuildScript, /--timestamp=none/);
});

test("local agentkit zip import is local, previewed, and hardened", async () => {
  const appSource = await readFile("src/App.tsx", "utf8");
  const rustSource = await readFile("src-tauri/src/lib.rs", "utf8");
  const tauriClientSource = await readFile("src/forge-client/tauri-client.ts", "utf8");

  assert.match(rustSource, /fn inspect_agent_kit_package/);
  assert.match(rustSource, /canonicalize_agent_kit_package/);
  assert.match(rustSource, /Selected package must end with \.agentkit\.zip/);
  assert.match(rustSource, /enclosed_name\(\)/);
  assert.match(rustSource, /validate_agent_kit_zip_structure/);
  assert.match(rustSource, /Package is missing agentkit\.yaml/);
  assert.match(rustSource, /Package is missing AGENTKIT\.md/);
  assert.match(rustSource, /Package must include at least one skill/);
  assert.match(rustSource, /Sha256::new/);
  assert.match(rustSource, /package_duplicate_warnings/);
  assert.match(rustSource, /source_market_slug/);
  assert.match(rustSource, /KitLibrarySource::LocalImport/);
  assert.match(rustSource, /Refusing to delete a folder that does not look like an Agent Kit/);
  assert.match(rustSource, /canonical_kit == canonical_library_root/);
  assert.match(tauriClientSource, /inspect_agent_kit_package/);
  assert.match(appSource, /forge\.inspectAgentKitPackage/);
  assert.match(appSource, /Package preview/);
  assert.match(appSource, /Import as copy/);
  assert.match(appSource, /source: "local_import"/);
  assert.match(appSource, /Import \.agentkit\.zip/);
  assert.doesNotMatch(appSource, /market\.agentkitproject\.com[\\s\\S]*import_agent_kit_package/);
});
