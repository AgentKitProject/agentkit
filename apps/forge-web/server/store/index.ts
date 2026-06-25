// Adapter selection factory for Web Forge persistence.
//
// KITSTORE_BACKEND selects the KitStore + UserSettingsStore implementation:
//   local    (default) — LocalDiskKitStore + disk UserSettingsStore.
//                         Needs a persistent volume; works self-host (k8s PV)
//                         but NOT on Amplify (ephemeral FS).
//   aws                — AwsKitStore (S3 trees + DynamoDB metadata) +
//                         AwsUserSettingsStore (DynamoDB). For hosted/Amplify.
//   selfhost           — SelfHostKitStore (Postgres metadata + MinIO/S3 trees)
//                         + SelfHostUserSettingsStore (Postgres). For k8s with
//                         bundled-or-external Postgres + MinIO.
//
// Required env per backend is documented in .env.example + README.md. The
// returned stores are singletons.
import type { KitStore } from "@/server/store/types";
import type { UserSettingsStore } from "@/server/store/settings-types";
import { awsClientEnv } from "@/server/aws-client";

export type StoreBackend = "local" | "aws" | "selfhost";

function backend(): StoreBackend {
  const raw = (process.env.KITSTORE_BACKEND || "local").toLowerCase();
  if (raw === "local" || raw === "aws" || raw === "selfhost") return raw;
  throw new Error(`Invalid KITSTORE_BACKEND="${raw}". Expected local | aws | selfhost.`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for KITSTORE_BACKEND=${backend()}.`);
  return v;
}

// awsClientEnv() now lives in server/aws-client.ts so the gateway credit ledger
// composes against the same region + credentials as the KitStore aws adapters.

let kitStoreSingleton: KitStore | null = null;
let settingsSingleton: UserSettingsStore | null = null;

async function buildKitStore(): Promise<KitStore> {
  switch (backend()) {
    case "aws": {
      const { AwsKitStore } = await import("@/server/store/aws-kit-store");
      return new AwsKitStore({
        kitsTable: requireEnv("DYNAMODB_KITS_TABLE"),
        s3Bucket: requireEnv("S3_BUCKET"),
        s3Prefix: process.env.S3_PREFIX,
        ...awsClientEnv()
      });
    }
    case "selfhost": {
      const { SelfHostKitStore } = await import("@/server/store/selfhost-kit-store");
      const { getSelfHostPgPool } = await import("@/server/store/selfhost-user-settings");
      return new SelfHostKitStore(await getSelfHostPgPool(), {
        s3Endpoint: requireEnv("S3_ENDPOINT"),
        s3Bucket: requireEnv("S3_BUCKET"),
        s3Prefix: process.env.S3_PREFIX,
        s3AccessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
        s3SecretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
        s3ForcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") !== "false",
        region: process.env.AWS_REGION
      });
    }
    default: {
      const { LocalDiskKitStore } = await import("@/server/store/local-disk");
      return new LocalDiskKitStore();
    }
  }
}

async function buildSettingsStore(): Promise<UserSettingsStore> {
  switch (backend()) {
    case "aws": {
      const { AwsUserSettingsStore } = await import("@/server/store/aws-user-settings");
      return new AwsUserSettingsStore({
        settingsTable: requireEnv("DYNAMODB_SETTINGS_TABLE"),
        ...awsClientEnv()
      });
    }
    case "selfhost": {
      const { SelfHostUserSettingsStore, getSelfHostPgPool } = await import(
        "@/server/store/selfhost-user-settings"
      );
      return new SelfHostUserSettingsStore(await getSelfHostPgPool());
    }
    default: {
      const { DiskUserSettingsStore } = await import("@/server/store/user-settings");
      return new DiskUserSettingsStore();
    }
  }
}

export async function getKitStore(): Promise<KitStore> {
  if (!kitStoreSingleton) kitStoreSingleton = await buildKitStore();
  return kitStoreSingleton;
}

export async function getUserSettingsStore(): Promise<UserSettingsStore> {
  if (!settingsSingleton) settingsSingleton = await buildSettingsStore();
  return settingsSingleton;
}
