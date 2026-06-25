import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { getUserRole } from "@/lib/auth/roles";
import { safeReturnTo } from "@/lib/auth/urls";

type AuthResult = Awaited<ReturnType<typeof withAuth>>;

export type AgentKitUser = NonNullable<AuthResult["user"]>;

export async function getCurrentUser() {
  const { user } = await withAuth();
  return user ?? null;
}

export async function requireUser(returnTo?: string) {
  const { user } = await withAuth();

  if (!user) {
    const returnPath = safeReturnTo(returnTo ?? (await getCurrentRequestPath()));

    console.info("[auth] protected route auth missing", {
      returnTo: returnPath,
    });

    redirect(`/auth/sign-in?returnTo=${encodeURIComponent(returnPath)}`);
  }

  return user;
}

export async function requireAdmin() {
  const user = await requireUser();
  const role = getUserRole(user);

  if (role !== "admin" && role !== "owner") {
    redirect("/unauthorized");
  }

  return { user, role };
}

async function getCurrentRequestPath() {
  const headersList = await headers();
  const requestUrl = headersList.get("x-url");

  if (!requestUrl) {
    return "/account";
  }

  try {
    const parsed = new URL(requestUrl);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/account";
  }
}
