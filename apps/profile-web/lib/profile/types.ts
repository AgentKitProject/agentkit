import type { UserRole } from "@/lib/auth/roles";

export type EditableProfileInput = {
  displayName: string;
  handle: string;
  avatarInitials: string;
  bio: string;
  websiteUrl: string;
};

export type PrivateProfile = EditableProfileInput & {
  userId: string;
  email: string;
  role: UserRole;
  verified: boolean;
  completeness: number;
  isComplete: boolean;
};

export type PublicProfile = Omit<EditableProfileInput, "email"> & {
  verified: boolean;
};

export type ProfileError = {
  field?: keyof EditableProfileInput;
  message: string;
};
