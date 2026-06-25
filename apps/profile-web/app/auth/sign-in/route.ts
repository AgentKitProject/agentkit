import { redirect } from "next/navigation";
import { getSignInUrl, getSignUpUrl } from "@/lib/auth/workos";
import { safeReturnTo } from "@/lib/auth/urls";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const returnTo = safeReturnTo(searchParams.get("returnTo"));

  console.info("[auth] sign-in route hit", {
    returnTo,
  });

  const signInUrl =
    searchParams.get("mode") === "sign-up"
      ? await getSignUpUrl(returnTo)
      : await getSignInUrl(returnTo);

  redirect(signInUrl);
}
