export type AgentKitMarketRole = "anonymous" | "user" | "admin" | "owner";

export type PermissionUser = {
  role: AgentKitMarketRole;
};

export function canViewKit() {
  return true;
}

export function canDownloadKit(user?: PermissionUser | null) {
  return Boolean(user);
}

export function canSubmitKit(user?: PermissionUser | null) {
  return Boolean(user);
}

export function canReviewSubmission(user?: PermissionUser | null) {
  return isAdminRole(user?.role);
}

export function canPublishKit(user?: PermissionUser | null) {
  return isAdminRole(user?.role);
}

export function isAdminRole(role?: AgentKitMarketRole | null) {
  return role === "admin" || role === "owner";
}
