// KitStore — the core server-side persistence abstraction for Web Forge.
//
// The desktop app stores kits on the local filesystem. The web build has no
// per-user local FS, so a kit is modeled as a *file tree* persisted by a
// KitStore, plus a small metadata record. The core runner (see
// ../core/runner.ts) materializes a tree into an ephemeral temp dir to run
// @agentkitforge/core against it, then persists the (possibly mutated) tree
// back here.
//
// FAVORITES are REFERENCES to Market kits, never copies: we store only the
// market ref + cached display metadata, so a favorite costs ~nothing and never
// duplicates kit content.
//
// One concrete adapter ships today: LocalDiskKitStore (server/store/local-disk.ts).
// The interface is intentionally adapter-agnostic so the following can be added
// later WITHOUT touching callers (see TODOs in local-disk.ts):
//   - Hosted:    S3 (kit-tree blobs) + DynamoDB (metadata + favorites)
//   - Self-host: Postgres (metadata + favorites) + MinIO/S3 (kit-tree blobs),
//                shareable with the Market self-host backend.

/** A single file in a kit tree. `path` is POSIX-relative to the kit root. */
export type KitFile = {
  path: string;
  /** UTF-8 text content. Binary files are base64 with `encoding: "base64"`. */
  content: string;
  encoding?: "utf8" | "base64";
};

/** A full kit file tree (the materializable unit). */
export type KitTree = {
  files: KitFile[];
};

export type KitMetadataRecord = {
  kitId: string;
  ownerUserId: string;
  /** Display name parsed from the manifest, best-effort. */
  name?: string;
  createdAt: string;
  updatedAt: string;
  /** How this kit entered the store. */
  source: "template" | "draft" | "upload-zip" | "git" | "market-import";
};

export type FavoriteRecord = {
  /** Market kit id and/or slug — the canonical reference. */
  marketKitId?: string;
  marketSlug: string;
  marketBaseUrl: string;
  /** Cached display metadata only (no kit content). */
  displayName?: string;
  publisher?: string;
  version?: string;
  addedAt: string;
};

export type CreateKitFromTemplate = {
  kind: "template";
  template: string;
  id: string;
  name: string;
  description: string;
};

export type CreateKitFromTree = {
  /** Used for draft-render and upload-zip flows: caller supplies the tree. */
  kind: "tree";
  tree: KitTree;
  source: KitMetadataRecord["source"];
  name?: string;
};

export type CreateKitInput = CreateKitFromTemplate | CreateKitFromTree;

export interface KitStore {
  // --- owned kits (drafts) -------------------------------------------------
  createKit(userId: string, input: CreateKitInput): Promise<KitMetadataRecord>;
  listUserKits(userId: string): Promise<KitMetadataRecord[]>;
  getKitMetadata(userId: string, kitId: string): Promise<KitMetadataRecord | null>;
  getKitTree(userId: string, kitId: string): Promise<KitTree>;
  /** Replace the entire tree (used by the runner after a mutation). */
  putKitTree(userId: string, kitId: string, tree: KitTree): Promise<void>;
  writeKitFile(userId: string, kitId: string, file: KitFile): Promise<void>;
  deleteKitFile(userId: string, kitId: string, path: string): Promise<void>;
  deleteKit(userId: string, kitId: string): Promise<void>;

  // --- quota ---------------------------------------------------------------
  /** Return the current kit-count and total-bytes for the account. */
  getUsage(userId: string): Promise<{ kitCount: number; bytes: number }>;

  // --- favorites (references to Market kits, NOT copies) -------------------
  addFavorite(userId: string, favorite: FavoriteRecord): Promise<FavoriteRecord>;
  listFavorites(userId: string): Promise<FavoriteRecord[]>;
  removeFavorite(userId: string, marketSlug: string): Promise<void>;
}
