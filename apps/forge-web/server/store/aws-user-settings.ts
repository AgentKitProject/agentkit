// AwsUserSettingsStore — hosted (AWS) per-user settings adapter.
//
// One DynamoDB row per user in <DYNAMODB_SETTINGS_TABLE> (PK userId), storing
// the whole UserSettings object (providers array, defaultProviderId,
// preferences). Provider API keys are AES-256-GCM encrypted at rest BEFORE the
// row is written (via the shared settings-logic), so DynamoDB never sees
// plaintext keys. The GET surface never returns secrets (hasApiKey only).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
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

export type AwsUserSettingsConfig = {
  settingsTable: string;
  region?: string;
  /** Explicit AWS credentials (FORGE_AWS_* on Amplify SSR); see AwsKitStoreConfig. */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  dynamoEndpoint?: string;
};

export class AwsUserSettingsStore implements UserSettingsStore {
  private readonly ddb: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(config: AwsUserSettingsConfig, deps?: { ddb?: DynamoDBDocumentClient }) {
    this.table = config.settingsTable;
    this.ddb =
      deps?.ddb ??
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          region: config.region ?? "us-east-1",
          ...(config.credentials ? { credentials: config.credentials } : {}),
          ...(config.dynamoEndpoint ? { endpoint: config.dynamoEndpoint } : {})
        }),
        { marshallOptions: { removeUndefinedValues: true } }
      );
  }

  private async read(userId: string): Promise<UserSettings> {
    assertSafeSegment(userId, "userId");
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { userId } }));
    if (!res.Item) return { ...EMPTY_SETTINGS };
    const s = res.Item.settings as UserSettings | undefined;
    return { providers: s?.providers ?? [], defaultProviderId: s?.defaultProviderId, preferences: s?.preferences };
  }

  private async write(userId: string, settings: UserSettings): Promise<void> {
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: { userId, settings } }));
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
