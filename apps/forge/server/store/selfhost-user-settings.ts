// SelfHostUserSettingsStore — self-host per-user settings adapter (Postgres).
//
// One row per user in user_settings (PK user_id) holding the whole UserSettings
// object as jsonb. Provider API keys are AES-256-GCM encrypted at rest BEFORE
// the row is written (shared settings-logic), so Postgres never sees plaintext
// keys. The GET surface never returns secrets. Schema created idempotently on
// first use.
import { ensureSchema, type PgPool } from "@/server/store/selfhost-pg";
import { assertSafeSegment } from "@/server/store/shared";
import {
  applyRemoveProvider,
  applySaveProvider,
  applySetDefault,
  applySetPreferences,
  resolveFromSettings,
  toPublic
} from "@/server/store/settings-logic";
import {
  EMPTY_SETTINGS,
  type PublicProvider,
  type SaveProviderInput,
  type StoredProvider,
  type UserSettings,
  type UserSettingsStore
} from "@/server/store/settings-types";

export class SelfHostUserSettingsStore implements UserSettingsStore {
  private readonly pool: PgPool;
  private ready: Promise<void> | null = null;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  private init(): Promise<void> {
    if (!this.ready) this.ready = ensureSchema(this.pool);
    return this.ready;
  }

  private async read(userId: string): Promise<UserSettings> {
    await this.init();
    assertSafeSegment(userId, "userId");
    const res = await this.pool.query(`SELECT settings FROM user_settings WHERE user_id = $1`, [userId]);
    const s = res.rows[0]?.settings as UserSettings | undefined;
    if (!s) return { ...EMPTY_SETTINGS };
    return { providers: s.providers ?? [], defaultProviderId: s.defaultProviderId, preferences: s.preferences };
  }

  private async write(userId: string, settings: UserSettings): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_settings (user_id, settings) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings`,
      [userId, JSON.stringify(settings)]
    );
  }

  async getPublic(userId: string) {
    return toPublic(await this.read(userId));
  }

  async saveProvider(userId: string, input: SaveProviderInput): Promise<PublicProvider> {
    const { settings, record } = applySaveProvider(await this.read(userId), input);
    await this.write(userId, settings);
    const { apiKey, ...rest } = record;
    return { ...rest, hasApiKey: Boolean(apiKey) };
  }

  async removeProvider(userId: string, providerId: string): Promise<void> {
    await this.write(userId, applyRemoveProvider(await this.read(userId), providerId));
  }

  async setPreferences(userId: string, preferences: Record<string, unknown>): Promise<void> {
    await this.write(userId, applySetPreferences(await this.read(userId), preferences));
  }

  async setDefault(userId: string, providerId: string): Promise<void> {
    await this.write(userId, applySetDefault(await this.read(userId), providerId));
  }

  async resolveProvider(userId: string, providerId?: string): Promise<(StoredProvider & { apiKey?: string }) | null> {
    return resolveFromSettings(await this.read(userId), providerId);
  }
}

// --- pg pool factory --------------------------------------------------------
// Lazily import `pg` so the package isn't required unless the self-host backend
// is actually selected (AWS/local deployments never load it).
let poolSingleton: PgPool | null = null;

export async function getSelfHostPgPool(): Promise<PgPool> {
  if (poolSingleton) return poolSingleton;
  // KITSTORE_DATABASE_URL (when set) points the KitStore at a SHARED kit DB so
  // Forge + Auto see the same kits; unset → DATABASE_URL (unchanged).
  const connectionString =
    process.env.KITSTORE_DATABASE_URL?.trim() || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for KITSTORE_BACKEND=selfhost.");
  const { Pool } = await import("pg");
  poolSingleton = new Pool({ connectionString }) as unknown as PgPool;
  return poolSingleton;
}
