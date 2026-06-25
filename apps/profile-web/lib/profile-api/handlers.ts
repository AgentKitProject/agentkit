import {
  HandleTakenError,
  toFullProfileResponse,
  toPublicProfile,
  type Profile,
  type ProfileStore,
} from "../store/store.ts";
import {
  ApiError,
  deriveInitials,
  normalizeHandle,
  nullableString,
  parseUpdateInput,
  validateAvatarInitials,
  validateBio,
  validateDisplayName,
  validateHandle,
  validateWebsiteUrl,
  type UpdateProfileInput,
} from "./validation.ts";

/** Trusted-context shape (mirrors lib/profile-api/trusted-context). */
export type TrustedContext = {
  userId: string;
  email?: string | null;
};

export type HandlerResult = {
  status: number;
  body: unknown;
};

/** GET /profiles/{userId} */
export async function getPublicProfileByUserId(store: ProfileStore, userId: string): Promise<HandlerResult> {
  if (!userId || userId.startsWith("HANDLE#")) {
    throw new ApiError(400, "Invalid userId");
  }

  const profile = await store.getByUserId(userId);
  if (!profile) {
    return { status: 404, body: { message: "Profile not found" } };
  }

  return { status: 200, body: toPublicProfile(profile) };
}

/** GET /profiles/handle/{handle} */
export async function getPublicProfileByHandle(store: ProfileStore, rawHandle: string): Promise<HandlerResult> {
  const handle = normalizeHandle(rawHandle);
  if (!handle) {
    throw new ApiError(400, "Invalid handle");
  }
  validateHandle(handle);

  const profile = await store.getByHandle(handle);
  if (!profile) {
    return { status: 404, body: { message: "Profile not found" } };
  }

  return { status: 200, body: toPublicProfile(profile) };
}

/** GET /me — lazy-creates the profile on first read. */
export async function getCurrentProfile(store: ProfileStore, context: TrustedContext): Promise<HandlerResult> {
  const now = new Date().toISOString();
  const seed: Profile = {
    userId: context.userId,
    email: context.email ?? null,
    displayName: null,
    handle: null,
    avatarInitials: null,
    bio: null,
    websiteUrl: null,
    verified: false,
    role: "user",
    createdAt: now,
    updatedAt: now,
  };

  const profile = await store.createIfAbsent(seed);
  return { status: 200, body: toFullProfileResponse(profile) };
}

/** PUT /me */
export async function updateCurrentProfile(
  store: ProfileStore,
  context: TrustedContext,
  rawInput: unknown,
): Promise<HandlerResult> {
  const input: UpdateProfileInput = parseUpdateInput(rawInput);

  const existing = await store.getByUserId(context.userId);
  const now = new Date().toISOString();
  const current: Profile = existing ?? {
    userId: context.userId,
    email: context.email ?? null,
    displayName: null,
    handle: null,
    avatarInitials: null,
    bio: null,
    websiteUrl: null,
    verified: false,
    role: "user",
    createdAt: now,
    updatedAt: now,
  };

  const displayName = nullableString(input.displayName, "displayName");
  if (displayName !== undefined) {
    validateDisplayName(displayName);
    current.displayName = displayName;
  }

  const bio = nullableString(input.bio, "bio");
  if (bio !== undefined) {
    validateBio(bio);
    current.bio = bio;
  }

  const websiteUrl = nullableString(input.websiteUrl, "websiteUrl");
  if (websiteUrl !== undefined) {
    validateWebsiteUrl(websiteUrl);
    current.websiteUrl = websiteUrl;
  }

  const avatarInitials = nullableString(input.avatarInitials, "avatarInitials");
  if (avatarInitials !== undefined) {
    validateAvatarInitials(avatarInitials);
    current.avatarInitials = avatarInitials || deriveInitials(current.displayName ?? null, context.email);
  } else if (!current.avatarInitials) {
    current.avatarInitials = deriveInitials(current.displayName ?? null, context.email);
  }

  const requestedHandle = nullableString(input.handle, "handle");
  const nextHandle = requestedHandle === undefined ? current.handle ?? null : normalizeHandle(requestedHandle);
  if (requestedHandle !== undefined && nextHandle !== null) {
    validateHandle(nextHandle);
  }

  if (context.email !== undefined) {
    current.email = context.email;
  }

  current.updatedAt = now;

  // Ensure the row exists before we UPDATE it (the Lambda's PutItem upserts;
  // our store splits create vs update).
  if (!existing) {
    await store.createIfAbsent({ ...current, handle: null });
  }

  const currentHandle = (existing?.handle ?? null) as string | null;
  if (nextHandle !== currentHandle) {
    try {
      await store.updateProfileAndHandle(current, nextHandle);
    } catch (error) {
      if (error instanceof HandleTakenError) {
        throw new ApiError(409, "Handle is already taken");
      }
      throw error;
    }
    current.handle = nextHandle;
    return { status: 200, body: toFullProfileResponse(current) };
  }

  current.handle = currentHandle;
  await store.updateProfile(current);
  return { status: 200, body: toFullProfileResponse(current) };
}
