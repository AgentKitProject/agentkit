/**
 * `agentkitforge market …` CLI commands — the headless-friendly hosted
 * AgentKitMarket client (login / logout / submit / import), wiring the pure
 * `@agentkitforge/core/market` operations to a terminal.
 *
 * This is the CLI ↔ market boundary: the spec engine stays pure and never
 * imports from here. All network/auth work goes through `src/market/`.
 *
 * Never log token values.
 */

import { Command } from "commander";

import { getAgentKitSummary } from "../app/summary.js";
import {
  checkEntitlement,
  createDefaultTokenStore,
  DEFAULT_MARKET_BASE_URL,
  ensureAccessToken,
  fetchLicensedKit,
  OnlineOnlyContentRefusedError,
  importKit,
  listFavorites,
  addFavorite,
  removeFavorite,
  login,
  logout,
  ReconnectRequiredError,
  submitKit,
  type DeviceLoginPrompt
} from "../market/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const profiles = ["local-valid", "publishable", "trusted", "verified"];

/**
 * Mirrors the Rust `missing_auth_config_message`: the WorkOS client id is the
 * only required piece of configuration for hosted-Market auth.
 */
export const MISSING_CLIENT_ID_MESSAGE =
  "Forge account connection is not configured. " +
  "Set AGENTKITPROJECT_WORKOS_CLIENT_ID to the WorkOS client id for your " +
  "AgentKitProject deployment, then retry.";

/**
 * Resolve the WorkOS client id from a `--client-id` override, falling back to
 * the `AGENTKITPROJECT_WORKOS_CLIENT_ID` environment variable. Throws a clear,
 * actionable error when neither is present.
 */
export function resolveClientId(override?: string): string {
  const candidate = override?.trim() || process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID?.trim();
  if (!candidate) {
    throw new Error(MISSING_CLIENT_ID_MESSAGE);
  }
  return candidate;
}

/**
 * Single source of truth for the hosted Market base URL: explicit flag →
 * `AGENTKITFORGE_MARKET_BASE_URL` env → the default hosted constant.
 */
export function resolveMarketBaseUrl(flag?: string): string {
  const candidate = flag?.trim() || process.env.AGENTKITFORGE_MARKET_BASE_URL?.trim();
  return candidate && candidate.length > 0 ? candidate : DEFAULT_MARKET_BASE_URL;
}

function describeUser(user?: { email?: string; id?: string }): string {
  if (!user) return "your AgentKitProject account";
  return user.email?.trim() || user.id?.trim() || "your AgentKitProject account";
}

/** Register the `market` command group onto an existing program. */
export function registerMarketCommands(program: Command): void {
  const market = program
    .command("market")
    .description("Hosted AgentKitMarket: login, submit, import");

  market
    .command("login")
    .description("Connect your AgentKitProject account via WorkOS device flow")
    .option("--client-id <id>", "WorkOS client id (overrides AGENTKITPROJECT_WORKOS_CLIENT_ID)")
    .action(async (options: { clientId?: string }) => {
      const clientId = resolveClientId(options.clientId);
      const store = createDefaultTokenStore();
      const result = await login(
        {
          clientId,
          onPrompt: (prompt: DeviceLoginPrompt) => {
            console.log("To connect your AgentKitProject account:");
            console.log(`  1. Visit: ${prompt.verificationUri}`);
            console.log(`  2. Enter code: ${prompt.userCode}`);
            if (prompt.verificationUriComplete) {
              console.log(`  Or open directly: ${prompt.verificationUriComplete}`);
            }
            console.log("Waiting for approval…");
          }
        },
        store
      );
      console.log(`Connected as ${describeUser(result.user)}.`);
    });

  market
    .command("logout")
    .description("Disconnect your AgentKitProject account (clears the stored session)")
    .action(async () => {
      const store = createDefaultTokenStore();
      await logout(store);
      console.log("Disconnected from hosted AgentKitMarket.");
    });

  market
    .command("submit")
    .description("Validate, package, and submit an Agent Kit to hosted AgentKitMarket")
    .argument("<kitPath>", "Agent Kit folder")
    .option("--market-url <url>", "Hosted Market base URL")
    .option("--profile <profile>", "Validation profile", "publishable")
    .option("--publisher-id <name>", "AgentKitProfile display name (publisher id)")
    .action(
      async (
        kitPath: string,
        options: { marketUrl?: string; profile: string; publisherId?: string }
      ) => {
        if (!profiles.includes(options.profile)) {
          throw new Error(`Invalid profile: ${options.profile}`);
        }
        const clientId = resolveClientId();
        const marketBaseUrl = resolveMarketBaseUrl(options.marketUrl);
        const store = createDefaultTokenStore();

        try {
          await ensureAccessToken(store, { clientId });
        } catch (error) {
          if (error instanceof ReconnectRequiredError) {
            throw new ReconnectRequiredError(
              "Not connected to hosted AgentKitMarket. Run `agentkitforge market login` first."
            );
          }
          throw error;
        }

        const publisherId =
          options.publisherId?.trim() || (await store.get())?.user?.email?.trim() || "";

        const result = await submitKit(store, {
          clientId,
          marketBaseUrl,
          rootPath: kitPath,
          publisherId
        });
        console.log(`Submission id: ${result.submissionId}`);
        console.log(`Status:        ${result.status}`);
        console.log(`Market link:   ${result.marketLink}`);
        console.log(`sha256:        ${result.sha256}`);
      }
    );

  market
    .command("import")
    .description("Import a kit from hosted AgentKitMarket by slug, ID, or URL")
    .argument("<slugOrIdOrUrl>", "Market kit slug, kit ID, or Market URL")
    .option("--market-url <url>", "Hosted Market base URL")
    .option("--target <dir>", "Directory to extract the kit into")
    .action(
      async (slugOrIdOrUrl: string, options: { marketUrl?: string; target?: string }) => {
        const clientId = resolveClientId();
        const marketBaseUrl = resolveMarketBaseUrl(options.marketUrl);
        const store = createDefaultTokenStore();

        try {
          await ensureAccessToken(store, { clientId });
        } catch (error) {
          if (error instanceof ReconnectRequiredError) {
            throw new ReconnectRequiredError(
              "Not connected to hosted AgentKitMarket. Run `agentkitforge market login` first."
            );
          }
          throw error;
        }

        const result = await importKit(store, {
          clientId,
          marketBaseUrl,
          slug: slugOrIdOrUrl,
          targetDir: options.target
        });
        let name = result.provenance.marketSlug;
        let version = result.provenance.version ?? "unknown";
        try {
          const summary = await getAgentKitSummary(result.rootPath);
          name = summary.name;
          version = summary.version;
        } catch {
          // Fall back to provenance if the extracted kit can't be summarized.
        }
        console.log(`Imported: ${name} (v${version})`);
        console.log(`Location: ${result.rootPath}`);
        console.log(`Source:   ${result.provenance.source}`);
        console.log(`Version:  ${result.provenance.version ?? "unknown"}`);
        console.log(`sha256:   ${result.provenance.sha256 ?? "unknown"}`);
      }
    );

  async function ensureConnected(clientId: string) {
    const store = createDefaultTokenStore();
    try {
      await ensureAccessToken(store, { clientId });
    } catch (error) {
      if (error instanceof ReconnectRequiredError) {
        throw new ReconnectRequiredError(
          "Not connected to hosted AgentKitMarket. Run `agentkitforge market login` first."
        );
      }
      throw error;
    }
    return store;
  }

  market
    .command("entitlement")
    .description("Check whether you hold an active entitlement for a Market kit")
    .argument("<slugOrIdOrUrl>", "Market kit slug, kit ID, or Market URL")
    .option("--market-url <url>", "Hosted Market base URL")
    .action(async (slugOrIdOrUrl: string, options: { marketUrl?: string }) => {
      const clientId = resolveClientId();
      const marketBaseUrl = resolveMarketBaseUrl(options.marketUrl);
      const store = await ensureConnected(clientId);
      const result = await checkEntitlement(store, {
        clientId,
        marketBaseUrl,
        slug: slugOrIdOrUrl
      });
      console.log(`Kit:         ${result.kitId ?? result.slug}`);
      console.log(`Pricing:     ${result.pricing}`);
      console.log(`Downloadable:${result.downloadable ? " yes" : " no"}`);
      console.log(`Online-only: ${result.onlineOnly ? "yes" : "no"}`);
      console.log(`Entitled:    ${result.entitled ? "yes" : "no"}`);
    });

  market
    .command("licensed-fetch")
    .description(
      "Fetch a licensed (paid) kit's watermarked package. Online-only kits are " +
        "held in memory and CANNOT be saved; downloadable paid kits may be saved with --out."
    )
    .argument("<slugOrIdOrUrl>", "Market kit slug, kit ID, or Market URL")
    .option("--market-url <url>", "Hosted Market base URL")
    .option("--out <file>", "Save the watermarked .agentkit.zip (downloadable paid kits only)")
    .action(
      async (slugOrIdOrUrl: string, options: { marketUrl?: string; out?: string }) => {
        const clientId = resolveClientId();
        const marketBaseUrl = resolveMarketBaseUrl(options.marketUrl);
        const store = await ensureConnected(clientId);

        // The CLI is a CLIENT (M6 Slice 1): it must NEVER receive the CONTENT of a
        // protected (online-only) kit. We do NOT pass `allowOnlineOnlyContent`, so
        // core refuses with OnlineOnlyContentRefusedError. Surface a clear,
        // content-free "run it on web Forge or Auto" message with run targets.
        let result;
        try {
          result = await fetchLicensedKit(store, {
            clientId,
            marketBaseUrl,
            slug: slugOrIdOrUrl
          });
        } catch (error) {
          if (error instanceof OnlineOnlyContentRefusedError) {
            const t = error.directive.runTargets;
            const targets = [
              t?.forgeWebUrl ? `  web Forge: ${t.forgeWebUrl}` : undefined,
              t?.autoUrl ? `  Auto:      ${t.autoUrl}` : undefined
            ].filter(Boolean);
            throw new Error(
              `${error.directive.message}` +
                (targets.length > 0 ? `\nRun it at:\n${targets.join("\n")}` : "")
            );
          }
          throw error;
        }

        console.log(`Kit:         ${result.kitId}`);
        console.log(`File:        ${result.fileName}`);
        console.log(`Size:        ${result.bytes.length} bytes`);
        console.log(`sha256:      ${result.sha256}`);
        console.log(`Pricing:     ${result.pricing}`);
        console.log(`Online-only: ${result.onlineOnly ? "yes" : "no"}`);
        if (result.watermark) {
          console.log(`Watermark:   ${result.watermark.hash}`);
        }

        if (options.out) {
          if (result.onlineOnly) {
            throw new Error(
              "This kit is online-only and cannot be saved or exported. " +
                "Online-only kits are held in memory only."
            );
          }
          const outPath = path.resolve(options.out);
          await mkdir(path.dirname(outPath), { recursive: true });
          await writeFile(outPath, result.bytes);
          console.log(`Saved watermarked package to: ${outPath}`);
        } else {
          console.log(
            "(in-memory only; pass --out to save a downloadable paid kit's watermarked package)"
          );
        }
      }
    );

  const favorites = market
    .command("favorites")
    .description("Cloud favorites (opt-in; requires an AgentKitProject session)");

  favorites
    .command("list")
    .description("List your synced cloud favorites")
    .option("--market-url <url>", "Hosted Market base URL")
    .action(async (options: { marketUrl?: string }) => {
      const clientId = resolveClientId();
      const marketBaseUrl = resolveMarketBaseUrl(options.marketUrl);
      const store = await ensureConnected(clientId);
      const items = await listFavorites(store, { clientId, marketBaseUrl });
      if (items.length === 0) {
        console.log("No cloud favorites.");
        return;
      }
      for (const fav of items) {
        console.log(`${fav.displayName ?? fav.slug} (${fav.slug})`);
      }
    });

  favorites
    .command("add")
    .description("Add a cloud favorite by slug, kit ID, or URL")
    .argument("<slugOrIdOrUrl>", "Market kit slug, kit ID, or Market URL")
    .option("--market-url <url>", "Hosted Market base URL")
    .action(async (slugOrIdOrUrl: string, options: { marketUrl?: string }) => {
      const clientId = resolveClientId();
      const marketBaseUrl = resolveMarketBaseUrl(options.marketUrl);
      const store = await ensureConnected(clientId);
      await addFavorite(store, { slug: slugOrIdOrUrl }, { clientId, marketBaseUrl });
      console.log(`Favorited: ${slugOrIdOrUrl}`);
    });

  favorites
    .command("remove")
    .description("Remove a cloud favorite by kit ID")
    .argument("<kitId>", "Market kit ID")
    .option("--market-url <url>", "Hosted Market base URL")
    .action(async (kitId: string, options: { marketUrl?: string }) => {
      const clientId = resolveClientId();
      const marketBaseUrl = resolveMarketBaseUrl(options.marketUrl);
      const store = await ensureConnected(clientId);
      await removeFavorite(store, kitId, { clientId, marketBaseUrl });
      console.log(`Removed favorite: ${kitId}`);
    });
}
