import { HandleTakenError, type Profile, type ProfileStore, type Role } from "./store.ts";

/**
 * Minimal structural type for a `pg` Pool / Client. Declared locally so the
 * `pg-mem` test Pool satisfies it directly and consumers only need `pg` types
 * structurally. Mirrors agentkitmarket-core's `PgQueryable`.
 */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: ProfileRow[]; rowCount: number | null }>;
}

type ProfileRow = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  handle: string | null;
  avatar_initials: string | null;
  bio: string | null;
  website_url: string | null;
  verified: boolean;
  role: Role;
  created_at: string | Date;
  updated_at: string | Date;
};

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

const COLUMNS =
  "user_id, email, display_name, handle, avatar_initials, bio, website_url, verified, role, created_at, updated_at";

export class PostgresProfileStore implements ProfileStore {
  private readonly pool: PgQueryable;

  constructor(pool: PgQueryable) {
    this.pool = pool;
  }

  async getByUserId(userId: string): Promise<Profile | null> {
    const result = await this.pool.query(`SELECT ${COLUMNS} FROM profiles WHERE user_id = $1`, [userId]);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async getByHandle(handle: string): Promise<Profile | null> {
    const result = await this.pool.query(`SELECT ${COLUMNS} FROM profiles WHERE lower(handle) = lower($1)`, [
      handle,
    ]);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async createIfAbsent(profile: Profile): Promise<Profile> {
    await this.pool.query(
      `INSERT INTO profiles (user_id, email, display_name, handle, avatar_initials, bio, website_url, verified, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id) DO NOTHING`,
      [
        profile.userId,
        profile.email ?? null,
        profile.displayName ?? null,
        profile.handle ?? null,
        profile.avatarInitials ?? null,
        profile.bio ?? null,
        profile.websiteUrl ?? null,
        profile.verified,
        profile.role,
        profile.createdAt,
        profile.updatedAt,
      ],
    );

    const existing = await this.getByUserId(profile.userId);
    if (!existing) {
      // Should be unreachable: the row exists after INSERT ... DO NOTHING.
      throw new Error("Failed to create or read profile after insert");
    }
    return existing;
  }

  async updateProfile(profile: Profile): Promise<void> {
    await this.pool.query(
      `UPDATE profiles
       SET email = $2, display_name = $3, avatar_initials = $4, bio = $5, website_url = $6,
           verified = $7, role = $8, updated_at = $9
       WHERE user_id = $1`,
      [
        profile.userId,
        profile.email ?? null,
        profile.displayName ?? null,
        profile.avatarInitials ?? null,
        profile.bio ?? null,
        profile.websiteUrl ?? null,
        profile.verified,
        profile.role,
        profile.updatedAt,
      ],
    );
  }

  async updateProfileAndHandle(profile: Profile, nextHandle: string | null): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE profiles
         SET email = $2, display_name = $3, avatar_initials = $4, bio = $5, website_url = $6,
             verified = $7, role = $8, updated_at = $9, handle = $10
         WHERE user_id = $1`,
        [
          profile.userId,
          profile.email ?? null,
          profile.displayName ?? null,
          profile.avatarInitials ?? null,
          profile.bio ?? null,
          profile.websiteUrl ?? null,
          profile.verified,
          profile.role,
          profile.updatedAt,
          nextHandle,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HandleTakenError();
      }
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === UNIQUE_VIOLATION);
}

function mapRow(row: ProfileRow): Profile {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    handle: row.handle,
    avatarInitials: row.avatar_initials,
    bio: row.bio,
    websiteUrl: row.website_url,
    verified: Boolean(row.verified),
    role: row.role,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
