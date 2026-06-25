import {
  getSignInUrl as getWorkOSSignInUrl,
  getSignUpUrl as getWorkOSSignUpUrl,
} from "@workos-inc/authkit-nextjs";
import { getWorkOSRedirectUri, safeReturnTo } from "@/lib/auth/urls";

export async function getSignInUrl(returnTo?: string | null) {
  return getWorkOSSignInUrl({
    redirectUri: getWorkOSRedirectUri(),
    returnTo: safeReturnTo(returnTo),
  });
}

export async function getSignUpUrl(returnTo?: string | null) {
  return getWorkOSSignUpUrl({
    redirectUri: getWorkOSRedirectUri(),
    returnTo: safeReturnTo(returnTo),
  });
}
